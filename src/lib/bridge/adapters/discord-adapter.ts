/**
 * Discord Adapter — implements BaseChannelAdapter for Discord via discord.js Gateway.
 *
 * Uses discord.js Client to connect via WebSocket Gateway, register application
 * commands (slash commands), and handle both interactions and regular messages.
 *
 * Key differences from Telegram adapter:
 * - Discord interactions must be acknowledged within 3 seconds (deferReply)
 * - Uses Gateway WebSocket (suitable for desktop app — no public URL needed)
 * - Message limit is 2000 characters (vs 4096 for Telegram)
 * - Discord natively supports Markdown (not HTML)
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Message as DiscordMessage,
  type TextChannel,
} from 'discord.js';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter';
import { getSetting, insertAuditLog } from '../../db';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Convert simple HTML (from bridge-manager command responses) to Discord Markdown.
 * Bridge-manager sends command responses as HTML; Discord uses its own Markdown.
 */
function htmlToDiscordMarkdown(html: string): string {
  return html
    .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
    .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<pre>([\s\S]*?)<\/pre>/g, '```\n$1\n```')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '') // Strip remaining HTML tags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

/** Build the slash command definitions to register with Discord API. */
function buildSlashCommands(): SlashCommandBuilder[] {
  return [
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Start a new CodePilot session')
      .addStringOption(opt =>
        opt.setName('path').setDescription('Working directory path').setRequired(false),
      ) as SlashCommandBuilder,
    new SlashCommandBuilder()
      .setName('bind')
      .setDescription('Bind to an existing session')
      .addStringOption(opt =>
        opt.setName('session_id').setDescription('Session ID to bind to').setRequired(true),
      ) as SlashCommandBuilder,
    new SlashCommandBuilder()
      .setName('cwd')
      .setDescription('Change working directory')
      .addStringOption(opt =>
        opt.setName('path').setDescription('New working directory').setRequired(true),
      ) as SlashCommandBuilder,
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('Switch mode')
      .addStringOption(opt =>
        opt.setName('mode').setDescription('Mode: plan, code, or ask').setRequired(true)
          .addChoices(
            { name: 'plan', value: 'plan' },
            { name: 'code', value: 'code' },
            { name: 'ask', value: 'ask' },
          ),
      ) as SlashCommandBuilder,
    new SlashCommandBuilder().setName('status').setDescription('Show current session status'),
    new SlashCommandBuilder().setName('sessions').setDescription('List recent sessions'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop the current task'),
    new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
  ];
}

// ── Adapter ─────────────────────────────────────────────────────

export class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'discord';

  private client: Client | null = null;
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  /** Pending deferred slash command interactions awaiting response (channelId → interaction). */
  private pendingInteractions = new Map<string, ChatInputCommandInteraction>();
  /** Typing indicator intervals per channel. */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  get botToken(): string {
    return getSetting('discord_bot_token') || '';
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[discord-adapter] Cannot start:', configError);
      return;
    }

    const token = this.botToken;

    // Register slash commands via REST API
    await this.registerCommands(token);

    // Create discord.js client with required Gateway intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Set up event handlers
    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch(err => {
        console.error('[discord-adapter] Interaction error:', err);
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessageCreate(message);
    });

    // Login and wait for ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord login timeout (30s)')), 30_000);
      this.client!.once(Events.ClientReady, () => {
        clearTimeout(timeout);
        console.log(`[discord-adapter] Logged in as ${this.client!.user?.tag}`);
        resolve();
      });
      this.client!.login(token).catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.running = true;
    console.log('[discord-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Clear typing indicators
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Destroy the client connection
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    this.pendingInteractions.clear();
    console.log('[discord-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Message Queue ───────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // ── Outbound ────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) return { ok: false, error: 'Discord client not connected' };

    const chatId = message.address.chatId;

    // Convert HTML to Discord Markdown when bridge-manager sends HTML
    const text = message.parseMode === 'HTML'
      ? htmlToDiscordMarkdown(message.text)
      : message.text;

    try {
      // Check for pending deferred slash command interaction
      const pending = this.pendingInteractions.get(chatId);
      if (pending) {
        this.pendingInteractions.delete(chatId);
        await pending.editReply({ content: text.slice(0, 2000) });
        return { ok: true, messageId: pending.id };
      }

      // Regular message: send to channel
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !('send' in channel)) {
        return { ok: false, error: `Channel ${chatId} not found or not text-based` };
      }

      const textChannel = channel as TextChannel;

      // Build Discord button components from inlineButtons (for permission prompts)
      const components = this.buildButtonComponents(message);

      // Try to reply to a specific message if requested
      if (message.replyToMessageId && 'messages' in textChannel) {
        try {
          const target = await (textChannel as any).messages.fetch(message.replyToMessageId);
          const sent = await target.reply({
            content: text.slice(0, 2000),
            ...(components.length > 0 ? { components } : {}),
          });
          return { ok: true, messageId: sent.id };
        } catch {
          // Original message not found — fall through to regular send
        }
      }

      const sent = await textChannel.send({
        content: text.slice(0, 2000),
        ...(components.length > 0 ? { components } : {}),
      });
      return { ok: true, messageId: sent.id };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Discord send error';
      return { ok: false, error: errMsg };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const token = getSetting('discord_bot_token');
    if (!token) return 'discord_bot_token not configured';

    const enabled = getSetting('bridge_discord_enabled');
    if (enabled !== 'true') return 'bridge_discord_enabled is not true';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    // Check bridge-specific allowed users
    const allowedUsers = getSetting('discord_bridge_allowed_users') || '';
    if (allowedUsers) {
      const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0) {
        return allowed.includes(userId) || allowed.includes(chatId);
      }
    }

    // Fallback: check allowed channel
    const allowedChannel = getSetting('discord_bridge_channel_id') || '';
    if (allowedChannel) {
      return chatId === allowedChannel;
    }

    // No auth configured — deny by default
    return false;
  }

  // ── Lifecycle Hooks ─────────────────────────────────────────

  onMessageStart(chatId: string): void {
    this.startTyping(chatId);
  }

  onMessageEnd(chatId: string): void {
    this.stopTyping(chatId);
  }

  // ── Private: Command Registration ───────────────────────────

  /**
   * Register slash commands with Discord REST API.
   * Guild-specific commands are available instantly; global commands take up to 1 hour.
   */
  private async registerCommands(token: string): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(token);
    const commandData = buildSlashCommands().map(cmd => cmd.toJSON());

    try {
      // Fetch application ID from the current bot token
      const appInfo = await rest.get(Routes.oauth2CurrentApplication()) as { id: string };
      const appId = appInfo.id;

      const guildId = getSetting('discord_guild_id') || '';
      if (guildId) {
        // Guild commands: available instantly
        await rest.put(Routes.applicationGuildCommands(appId, guildId), {
          body: commandData,
        });
        console.log(`[discord-adapter] Registered ${commandData.length} guild commands for guild ${guildId}`);
      } else {
        // Global commands: may take up to 1 hour to propagate
        await rest.put(Routes.applicationCommands(appId), {
          body: commandData,
        });
        console.log(`[discord-adapter] Registered ${commandData.length} global commands (propagation may take up to 1h)`);
      }
    } catch (err) {
      console.error('[discord-adapter] Failed to register commands:', err);
      throw err;
    }
  }

  // ── Private: Inbound Handling ───────────────────────────────

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Handle Discord interactions: slash commands and button clicks.
   */
  private async handleInteraction(interaction: import('discord.js').Interaction): Promise<void> {
    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      await this.handleSlashCommand(interaction);
      return;
    }

    // ── Button Clicks (permission prompts) ──
    if (interaction.isButton()) {
      await this.handleButtonClick(interaction);
      return;
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username;

    if (!this.isAuthorized(userId, chatId)) {
      await interaction.reply({
        content: 'You are not authorized to use this bot.',
        ephemeral: true,
      });
      return;
    }

    // Defer reply to avoid the 3-second interaction timeout
    await interaction.deferReply();
    this.pendingInteractions.set(chatId, interaction);

    // Convert interaction to text command (bridge-manager expects `/command args` format)
    const commandName = interaction.commandName;
    let args = '';
    switch (commandName) {
      case 'new':
        args = interaction.options.getString('path') || '';
        break;
      case 'bind':
        args = interaction.options.getString('session_id') || '';
        break;
      case 'cwd':
        args = interaction.options.getString('path') || '';
        break;
      case 'mode':
        args = interaction.options.getString('mode') || '';
        break;
    }

    const text = args ? `/${commandName} ${args}` : `/${commandName}`;

    try {
      insertAuditLog({
        channelType: 'discord',
        chatId,
        direction: 'inbound',
        messageId: interaction.id,
        summary: text.slice(0, 200),
      });
    } catch { /* best effort */ }

    this.enqueue({
      messageId: interaction.id,
      address: { channelType: 'discord', chatId, userId, displayName },
      text,
      timestamp: Date.now(),
      raw: interaction,
    });
  }

  private async handleButtonClick(interaction: ButtonInteraction): Promise<void> {
    const chatId = interaction.channelId;
    const userId = interaction.user.id;
    const displayName = interaction.user.username;

    if (!this.isAuthorized(userId, chatId)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true });
      return;
    }

    // Acknowledge the button click without editing the message
    await interaction.deferUpdate();

    this.enqueue({
      messageId: interaction.id,
      address: { channelType: 'discord', chatId, userId, displayName },
      text: '',
      timestamp: Date.now(),
      callbackData: interaction.customId,
      callbackMessageId: interaction.message.id,
      raw: interaction,
    });
  }

  /**
   * Handle regular Discord messages (non-interaction).
   */
  private handleMessageCreate(message: DiscordMessage): void {
    // Ignore bot messages (including our own)
    if (message.author.bot) return;

    const chatId = message.channelId;
    const userId = message.author.id;
    const displayName = message.author.username;

    if (!this.isAuthorized(userId, chatId)) return;

    const text = message.content || '';
    if (!text.trim()) return;

    try {
      insertAuditLog({
        channelType: 'discord',
        chatId,
        direction: 'inbound',
        messageId: message.id,
        summary: text.slice(0, 200),
      });
    } catch { /* best effort */ }

    this.enqueue({
      messageId: message.id,
      address: { channelType: 'discord', chatId, userId, displayName },
      text,
      timestamp: message.createdTimestamp,
      raw: message,
    });
  }

  // ── Private: UI Helpers ─────────────────────────────────────

  /**
   * Convert bridge InlineButton definitions to Discord ActionRow components.
   */
  private buildButtonComponents(
    message: OutboundMessage,
  ): ActionRowBuilder<ButtonBuilder>[] {
    if (!message.inlineButtons || message.inlineButtons.length === 0) return [];

    return message.inlineButtons.map(row =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...row.map(btn =>
          new ButtonBuilder()
            .setCustomId(btn.callbackData)
            .setLabel(btn.text)
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    );
  }

  private startTyping(chatId: string): void {
    this.stopTyping(chatId);
    if (!this.client) return;

    const sendTyping = async () => {
      try {
        const channel = await this.client?.channels.fetch(chatId);
        if (channel && channel.isTextBased()) {
          await (channel as TextChannel).sendTyping();
        }
      } catch { /* best effort */ }
    };

    // Send immediately, then repeat every 8s (Discord typing indicator lasts ~10s)
    sendTyping();
    const interval = setInterval(sendTyping, 8000);
    this.typingIntervals.set(chatId, interval);
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }
}

// Self-register so bridge-manager can create DiscordAdapter via the registry.
registerAdapterFactory('discord', () => new DiscordAdapter());
