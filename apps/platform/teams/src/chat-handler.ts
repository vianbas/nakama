import type { NakamaClient, RemoteChatSession } from "@nakama/client";
import { splitTelegramChunks } from "@nakama/core";
import { formatClientError } from "@nakama/core/api-error";
import {
  clearActiveStream,
  registerActiveStream,
  stopActiveStream,
} from "@nakama/core/channel-active-stream";
import { createChatLock } from "@nakama/core/channel-chat-lock";
import type { ChannelOwner } from "@nakama/core/channel-config-shared";
import type { ChannelSessionStore } from "@nakama/core/channel-session-store";
import type { TeamsConfigFile } from "@nakama/core/teams-config";

/** The parts of a Teams message activity this slice acts on. */
export interface TeamsActivity {
  /** The Bot Framework channel; only "msteams" is served. */
  channelId: string;
  conversationId: string;
  /** "personal" is a one-to-one chat; group chats and channels are ignored. */
  conversationType: string;
  id: string;
  isBot: boolean;
  /** The sender's Entra object id, which the allowlist is written against. */
  senderId: string;
  tenantId: string;
  text: string;
}

export interface TeamsChatHandlerDeps {
  client: NakamaClient;
  /** Read per turn, so an administrator's change applies to queued work. */
  loadConfig: () => Promise<TeamsConfigFile | null>;
  owner: ChannelOwner;
  send: (conversationId: string, text: string) => Promise<void>;
  sessionStore: ChannelSessionStore;
}

const chatLock = createChatLock({ waitMs: 15 * 60 * 1000 });

/** Teams retries an activity it thinks was not acknowledged. */
const SEEN_ACTIVITY_LIMIT = 500;

/**
 * Teams refuses a message of about 28 KB. Even at four bytes a character this
 * stays under it, with room for the activity around the text.
 */
const TEAMS_MAX_MESSAGE_CHARS = 6000;

// "!" and not "/": typing "/" in Teams opens its own command menu.
const HELP_TEXT = [
  "Chat with me in this chat.",
  "",
  "!new: start a fresh conversation",
  "!clear: clear this conversation's history",
  "!stop: stop the current reply",
  "!status: server and model status",
  "!help: this message",
].join("\n");

/** "!New please" is "new"; a message that is not a command is null. */
function parseCommand(text: string): string | null {
  if (!text.startsWith("!")) {
    return null;
  }

  // Phone keyboards capitalise the first letter of a message.
  return (text.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
}

function isPersonalMessage(activity: TeamsActivity): boolean {
  return (
    activity.channelId === "msteams" &&
    activity.conversationType === "personal" &&
    !activity.isBot &&
    activity.text.trim().length > 0 &&
    activity.conversationId.trim().length > 0
  );
}

/**
 * An empty allowlist denies everyone, which is what an unset one means. Entra
 * ids are GUIDs, which compare without regard to letter case.
 */
function allows(
  config: TeamsConfigFile | null,
  activity: TeamsActivity
): boolean {
  return (
    config !== null &&
    config.tenantId.toLowerCase() === activity.tenantId.toLowerCase() &&
    config.allowedUserIds.includes(activity.senderId.toLowerCase())
  );
}

export function createTeamsChatHandler(deps: TeamsChatHandlerDeps) {
  const { client, loadConfig, owner, send, sessionStore } = deps;
  const seenActivities = new Set<string>();

  async function resolveSession(
    scoped: NakamaClient,
    sessionKey: string
  ): Promise<RemoteChatSession> {
    // A session saved for another agent never continues under this one.
    if (sessionStore.get(sessionKey)?.profileId !== owner.profileId) {
      sessionStore.delete(sessionKey);
    }

    const existing = sessionStore.get(sessionKey);

    if (existing) {
      const hot = sessionStore.getHotSession<RemoteChatSession>(sessionKey);

      if (hot) {
        return hot;
      }

      const session = scoped.createChatSession(existing.sessionId, "teams");

      try {
        await session.getMessages();
        sessionStore.setHotSession(sessionKey, session);

        return session;
      } catch {
        // The server no longer has it; fall through and start a new one.
      }
    }

    return createAndBindSession(scoped, sessionKey);
  }

  async function createAndBindSession(
    scoped: NakamaClient,
    sessionKey: string
  ): Promise<RemoteChatSession> {
    const session = await scoped.createSession("teams", {
      profileId: owner.profileId,
    });

    sessionStore.set(sessionKey, {
      profileId: owner.profileId,
      sessionId: session.id,
      updatedAt: new Date().toISOString(),
    });
    sessionStore.setHotSession(sessionKey, session);
    await sessionStore.save();

    return session;
  }

  async function reply(conversationId: string, text: string): Promise<void> {
    for (const chunk of splitTelegramChunks(text, TEAMS_MAX_MESSAGE_CHARS)) {
      await send(conversationId, chunk);
    }
  }

  async function describeStatus(sessionKey: string): Promise<string> {
    try {
      const scoped = client.forOrg(owner.orgId);
      const health = await scoped.health();

      const lines = [
        `Server: ${health.ok ? "ok" : "degraded"}`,
        `Provider configured: ${health.providerConfigured ? "yes" : "no"}`,
      ];

      if (health.providerConfigured) {
        const models = await scoped.getModels();
        const { profiles } = await scoped.listProfiles(owner.orgId);
        const profile = profiles.find((entry) => entry.id === owner.profileId);

        const modelLabel = profile?.model?.includes("::")
          ? profile.model.slice(profile.model.indexOf("::") + 2)
          : (profile?.model ?? "none");

        lines.push(`Agent: ${profile?.name ?? owner.profileId}`);
        lines.push(`Provider: ${models.provider ?? "unknown"}`);
        lines.push(`Model: ${modelLabel}`);
      } else {
        lines.push("Chat runs in offline mode without an API key.");
      }

      const sessionId = sessionStore.get(sessionKey)?.sessionId;

      if (sessionId) {
        lines.push(`Session: ${sessionId.slice(0, 8)}`);
      }

      return lines.join("\n");
    } catch (error) {
      return formatClientError(error);
    }
  }

  /** Answers a "!word" message. It never reaches the agent as a turn. */
  async function handleCommand(
    command: string,
    activity: TeamsActivity,
    sessionKey: string
  ): Promise<void> {
    const answer = (text: string) => reply(activity.conversationId, text);

    switch (command) {
      case "stop": {
        // Not behind the lock: the turn it stops is holding it.
        await answer(
          stopActiveStream(sessionKey) ? "Stopping…" : "Nothing to stop."
        );

        return;
      }

      case "help": {
        await answer(HELP_TEXT);

        return;
      }

      case "status": {
        await answer(await describeStatus(sessionKey));

        return;
      }

      case "new":
      case "clear": {
        // A turn holds the chat lock until it ends, so stop it before
        // queueing on the lock; otherwise this waits for the whole turn.
        stopActiveStream(sessionKey);

        await chatLock.withLock(sessionKey, async () => {
          if (!allows(await loadConfig(), activity)) {
            return;
          }

          try {
            const scoped = client.forOrg(owner.orgId);

            if (command === "new") {
              await createAndBindSession(scoped, sessionKey);
              await answer("Started a new conversation.");
            } else {
              await (await resolveSession(scoped, sessionKey)).clear();
              await answer("History cleared.");
            }
          } catch (error) {
            await answer(formatClientError(error));
          }
        });

        return;
      }

      default:
        await answer("Unknown command. Send !help for the list.");
    }
  }

  return async function handle(activity: TeamsActivity): Promise<void> {
    if (!isPersonalMessage(activity)) {
      return;
    }

    // Checked before the first await so a retry that arrives while the first
    // delivery is still running cannot start a second turn. Ids are unique
    // within a chat; one without an id cannot be told apart from a retry.
    const deliveryKey = activity.id
      ? `${activity.conversationId}:${activity.id}`
      : null;

    if (deliveryKey !== null) {
      if (seenActivities.has(deliveryKey)) {
        return;
      }

      seenActivities.add(deliveryKey);

      if (seenActivities.size > SEEN_ACTIVITY_LIMIT) {
        const oldest = seenActivities.values().next().value;

        if (oldest !== undefined) {
          seenActivities.delete(oldest);
        }
      }
    }

    if (!allows(await loadConfig(), activity)) {
      return;
    }

    const sessionKey = `teams:${activity.conversationId}`;
    const text = activity.text.trim();
    const command = parseCommand(text);

    if (command !== null) {
      await handleCommand(command, activity, sessionKey);

      return;
    }

    await chatLock.withLock(sessionKey, async () => {
      // Read again: the turn may have waited behind a long one, and the
      // administrator may have removed this user in the meantime.
      if (!allows(await loadConfig(), activity)) {
        return;
      }

      // Registered first, so !stop also lands while the session loads.
      const signal = registerActiveStream(sessionKey);
      let answer: string | null;

      try {
        // Every request for this chat runs as the owning organization.
        const session = await resolveSession(
          client.forOrg(owner.orgId),
          sessionKey
        );

        // Streamed only so the turn can be aborted; the reply is still sent
        // only once it is complete.
        answer = await session.sendStream({ message: text }, () => {}, {
          signal,
        });
      } catch (error) {
        // The sender passed every access check, so they hear why nothing came.
        // A stop is answered below; any other failure, abort or not, is told.
        answer = signal.aborted ? null : formatClientError(error);
      } finally {
        clearActiveStream(sessionKey, signal);
      }

      if (answer) {
        await reply(activity.conversationId, answer);
      }

      if (signal.aborted) {
        await reply(activity.conversationId, "Stopped.");
      }
    });
  };
}
