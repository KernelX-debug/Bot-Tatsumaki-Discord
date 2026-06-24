require('dotenv').config();

const { spawn } = require('node:child_process');
const { PassThrough, Readable } = require('node:stream');
const {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const Groq = require('groq-sdk');
const ytDlp = require('yt-dlp-exec');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1328382983547387999';
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID || process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || process.env.SAY_GUILD_ID;
const SAY_GUILD_ID = process.env.SAY_GUILD_ID || COMMAND_GUILD_ID;
const SAY_CHANNEL_ID = process.env.SAY_CHANNEL_ID || WELCOME_CHANNEL_ID;
const BOT_PREFIX = '!';
const CHAT_MODEL = 'llama-3.1-8b-instant';
const TTS_MODEL = 'canopylabs/orpheus-v1-english';
const TTS_VOICE = 'diana';
const MAX_TTS_CHARS = 200;
const TTS_SPEED = clampNumber(Number(process.env.TTS_SPEED || '0.86'), 0.5, 1.5);
const MUSIC_MAX_SECONDS = Number(process.env.MUSIC_MAX_SECONDS || 10_800);
const MUSIC_QUEUE_LIMIT = Number(process.env.MUSIC_QUEUE_LIMIT || 25);
const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'spotify.link']);
const YOUTUBE_HOST_PATTERN = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)music\.youtube\.com$/i;

if (!DISCORD_TOKEN) {
  throw new Error('Falta DISCORD_TOKEN en el archivo .env');
}

if (!GROQ_API_KEY) {
  throw new Error('Falta GROQ_API_KEY en el archivo .env');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const sayCommand = new SlashCommandBuilder()
  .setName('say')
  .setDescription('Envia un mensaje como el bot en el canal configurado.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addStringOption((option) => option
    .setName('texto')
    .setDescription('Texto que enviara el bot.')
    .setRequired(true)
    .setMaxLength(2000));

const playCommand = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Reproduce musica en tu canal de voz.')
  .setDMPermission(false)
  .addStringOption((option) => option
    .setName('consulta')
    .setDescription('Nombre, link de YouTube o link de una cancion de Spotify.')
    .setRequired(true)
    .setMaxLength(500));

const queueCommand = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Muestra la cola de musica.')
  .setDMPermission(false);

const skipCommand = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Salta la cancion actual.')
  .setDMPermission(false);

const stopCommand = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Detiene la musica y limpia la cola.')
  .setDMPermission(false);

const leaveCommand = new SlashCommandBuilder()
  .setName('leave')
  .setDescription('Desconecta el bot del canal de voz.')
  .setDMPermission(false);

const nowPlayingCommand = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Muestra la cancion que esta sonando.')
  .setDMPermission(false);

const groq = new Groq({ apiKey: GROQ_API_KEY });
const conversaciones = new Map();
const voiceSessions = new Map();

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getUrlHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isYoutubeUrl(value) {
  return isHttpUrl(value) && YOUTUBE_HOST_PATTERN.test(getUrlHost(value));
}

function isSpotifyUrl(value) {
  return isHttpUrl(value) && SPOTIFY_HOSTS.has(getUrlHost(value));
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'desconocida';
  }

  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function getTrackDisplay(track) {
  const duration = formatDuration(track.duration);
  return `**${track.title}** (${duration})`;
}

function getSpotifyType(spotifyUrl) {
  try {
    const url = new URL(spotifyUrl);
    const [, type] = url.pathname.split('/');
    return type || '';
  } catch {
    return '';
  }
}

async function getSpotifySearchQuery(spotifyUrl) {
  const spotifyType = getSpotifyType(spotifyUrl);

  if (spotifyType !== 'track') {
    throw new Error('Por ahora solo puedo convertir links de canciones de Spotify. Para albums o playlists, pasame el nombre de la cancion.');
  }

  const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`);
  if (!response.ok) {
    throw new Error('No pude leer ese link de Spotify. Prueba con el nombre de la cancion.');
  }

  const data = await response.json();
  const title = String(data.title || '').trim();

  if (!title) {
    throw new Error('Spotify no devolvio datos utiles para buscar la cancion.');
  }

  return `${title
    .replace(/\s*\|\s*Spotify$/i, '')
    .replace(/\s*-\s*song and lyrics by\s*/i, ' ')
    .trim()} official audio`;
}

function normalizeYtdlpEntry(info) {
  const entry = Array.isArray(info?.entries) ? info.entries.find(Boolean) : info;

  if (!entry) {
    return null;
  }

  return {
    title: entry.title || entry.fulltitle || 'Cancion sin titulo',
    duration: Number(entry.duration || 0),
    webpageUrl: entry.webpage_url || entry.original_url || entry.url,
    streamUrl: entry.url,
    thumbnail: entry.thumbnail,
    isLive: Boolean(entry.is_live || entry.live_status === 'is_live'),
    httpHeaders: entry.http_headers || {},
  };
}

async function fetchYtdlpInfo(target) {
  return ytDlp(target, {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    format: 'bestaudio/best',
    socketTimeout: 15,
  });
}

async function resolveMusicQuery(input, requestedBy) {
  const rawQuery = input.trim();
  if (!rawQuery) {
    throw new Error('Pasame un nombre o link para buscar.');
  }

  let lookup = rawQuery;
  let source = 'YouTube';

  if (isSpotifyUrl(rawQuery)) {
    lookup = `ytsearch1:${await getSpotifySearchQuery(rawQuery)}`;
    source = 'Spotify -> YouTube';
  } else if (!isYoutubeUrl(rawQuery)) {
    lookup = `ytsearch1:${rawQuery}`;
    source = 'Busqueda de YouTube';
  }

  const info = await fetchYtdlpInfo(lookup);
  const track = normalizeYtdlpEntry(info);

  if (!track?.streamUrl) {
    throw new Error('No encontre resultados reproducibles.');
  }

  if (track.isLive) {
    throw new Error('No reproduzco directos o lives por ahora.');
  }

  if (track.duration > MUSIC_MAX_SECONDS) {
    throw new Error(`Esa cancion dura ${formatDuration(track.duration)}. El limite actual es ${formatDuration(MUSIC_MAX_SECONDS)}.`);
  }

  return {
    ...track,
    requestedBy,
    originalQuery: rawQuery,
    source,
  };
}

function enqueueAudioTask(session, task, label = 'audio') {
  const run = session.queue.then(task);

  session.queue = run.catch((error) => {
    console.error(`Error en la cola de ${label}:`, error);
  });

  return run;
}

function getConversationHistory(userId) {
  if (!conversaciones.has(userId)) {
    conversaciones.set(userId, []);
  }

  return conversaciones.get(userId);
}

function sanitizeMention(content) {
  return content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();
}

function splitForTts(text, maxLength = MAX_TTS_CHARS) {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return [];
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [normalized];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      const words = sentence.split(' ');
      let longChunk = '';

      for (const word of words) {
        const candidate = longChunk ? `${longChunk} ${word}` : word;
        if (candidate.length <= maxLength) {
          longChunk = candidate;
          continue;
        }

        if (longChunk) {
          chunks.push(longChunk.trim());
        }

        if (word.length <= maxLength) {
          longChunk = word;
        } else {
          const parts = word.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
          chunks.push(...parts);
          longChunk = '';
        }
      }

      if (longChunk) {
        chunks.push(longChunk.trim());
      }

      continue;
    }

    const candidate = current ? `${current} ${sentence}`.trim() : sentence.trim();
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
      }
      current = sentence.trim();
    }
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

function buildSystemPrompt(guild) {
  const emojisServidor = guild.emojis.cache
    .map((emoji) => (emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`));

  const emojisTexto = emojisServidor.length > 0
    ? `Tienes acceso a estos emojis del servidor, usalos de forma natural y random en tus respuestas: ${emojisServidor.join(', ')}`
    : '';

  return `Eres un pata peruano del servidor, hablas con jerga criolla y casual, haces bromas y te llevas con todos como amigos de barrio. ${emojisTexto}`.trim();
}

async function createGroqReply(message, userText) {
  const historial = getConversationHistory(message.author.id);
  historial.push({ role: 'user', content: userText });

  if (historial.length > 20) {
    historial.splice(0, historial.length - 20);
  }

  const respuesta = await groq.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(message.guild),
      },
      ...historial,
    ],
    max_tokens: 1024,
    temperature: 0.8,
  });

  const textoRespuesta = respuesta.choices?.[0]?.message?.content?.trim();

  if (!textoRespuesta) {
    throw new Error('Groq no devolvio texto en la respuesta.');
  }

  historial.push({ role: 'assistant', content: textoRespuesta });
  return textoRespuesta;
}

function getVoiceSession(guildId) {
  return voiceSessions.get(guildId) || null;
}

async function joinMemberVoiceChannel(member) {
  const voiceChannel = member.voice.channel;

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    throw new Error('Debes estar en un canal de voz normal para que entre.');
  }

  if (!voiceChannel.joinable || !voiceChannel.speakable) {
    throw new Error('No tengo permisos para entrar o hablar en ese canal de voz.');
  }

  let session = getVoiceSession(member.guild.id);

  if (!session) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    connection.subscribe(player);
    player.on('error', (error) => {
      console.error('Error del reproductor de voz:', error);
    });

    session = {
      connection,
      player,
      queue: Promise.resolve(),
      channelId: voiceChannel.id,
      musicQueue: [],
      currentTrack: null,
      musicTaskScheduled: false,
    };

    connection.on('stateChange', (_, newState) => {
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        voiceSessions.delete(member.guild.id);
      }
    });

    voiceSessions.set(member.guild.id, session);
  } else if (session.channelId !== voiceChannel.id) {
    session.connection.rejoin({
      channelId: voiceChannel.id,
      selfDeaf: false,
      selfMute: false,
    });
    session.channelId = voiceChannel.id;
  }

  await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);
  return session;
}

function leaveGuildVoice(guildId) {
  const session = getVoiceSession(guildId);
  if (!session) {
    return false;
  }

  session.musicQueue.length = 0;
  session.currentTrack = null;
  session.musicTaskScheduled = false;
  session.player.stop(true);
  session.connection.destroy();
  voiceSessions.delete(guildId);
  return true;
}

async function synthesizeSpeechToBuffer(text) {
  try {
    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: `[casual] ${text}`,
      response_format: 'wav',
      sample_rate: 48000,
    });

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.includes('model_terms_required')) {
      throw new Error(`Groq bloqueo la voz porque todavia no aceptaste los terminos del modelo ${TTS_MODEL}. Entra a https://console.groq.com/playground?model=${encodeURIComponent(TTS_MODEL)} y aceptalos.`);
    }

    throw error;
  }
}

async function convertWavToPcmBuffer(wavBuffer) {
  const speed = clampNumber(TTS_SPEED, 0.5, 1.5);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-filter:a',
    `atempo=${speed}`,
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, { windowsHide: true });
    const stdout = [];
    const stderr = [];

    ffmpeg.stdout.on('data', (chunk) => stdout.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => stderr.push(chunk));
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }

      reject(new Error(`FFmpeg no pudo convertir la voz: ${Buffer.concat(stderr).toString('utf8').trim() || `codigo ${code}`}`));
    });

    ffmpeg.stdin.end(wavBuffer);
  });
}

async function createPcmResourceFromWavBuffer(wavBuffer) {
  const pcmBuffer = await convertWavToPcmBuffer(wavBuffer);

  const stream = new PassThrough();
  stream.end(pcmBuffer);

  return createAudioResource(stream, {
    inputType: StreamType.Raw,
  });
}

async function playSpeechChunk(session, textChunk) {
  const wavBuffer = await synthesizeSpeechToBuffer(textChunk);
  const resource = await createPcmResourceFromWavBuffer(wavBuffer);
  session.player.play(resource);

  try {
    await entersState(session.player, AudioPlayerStatus.Playing, 20_000);
  } catch (error) {
    throw new Error(`No se pudo empezar a reproducir el audio. Estado actual del player: ${session.player.state.status}`);
  }

  await entersState(session.player, AudioPlayerStatus.Idle, 60_000);
}

async function speakInVoice(session, text) {
  const chunks = splitForTts(text);

  if (chunks.length === 0) {
    return;
  }

  await enqueueAudioTask(session, async () => {
    for (const chunk of chunks) {
      await playSpeechChunk(session, chunk);
    }
  }, 'voz');
}

async function createMusicResource(track) {
  const info = await fetchYtdlpInfo(track.webpageUrl || track.originalQuery);
  const freshTrack = normalizeYtdlpEntry(info);
  const streamUrl = freshTrack?.streamUrl;

  if (!streamUrl) {
    throw new Error('No pude refrescar el enlace de audio.');
  }

  const response = await fetch(streamUrl, {
    headers: freshTrack.httpHeaders || {},
  });

  if (!response.ok || !response.body) {
    throw new Error(`No pude abrir el stream de audio (${response.status}).`);
  }

  const stream = Readable.fromWeb
    ? Readable.fromWeb(response.body)
    : Readable.from(response.body);

  return createAudioResource(stream, {
    inputType: StreamType.Arbitrary,
    metadata: track,
  });
}

async function announceTrackStart(session, guild, track) {
  if (!track.textChannelId) {
    return;
  }

  const channel = await guild.channels.fetch(track.textChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    return;
  }

  await channel.send(`Reproduciendo: ${getTrackDisplay(track)}`);
}

async function playMusicTrack(session, guild, track) {
  session.currentTrack = track;

  try {
    const resource = await createMusicResource(track);
    session.player.play(resource);

    await entersState(session.player, AudioPlayerStatus.Playing, 20_000);
    await announceTrackStart(session, guild, track);

    const idleTimeout = Math.max(60_000, ((track.duration || 300) + 120) * 1000);
    await entersState(session.player, AudioPlayerStatus.Idle, idleTimeout);
  } finally {
    session.currentTrack = null;
  }
}

function scheduleNextMusicTrack(session, guild) {
  if (session.musicTaskScheduled || session.musicQueue.length === 0) {
    return;
  }

  session.musicTaskScheduled = true;

  enqueueAudioTask(session, async () => {
    const track = session.musicQueue.shift();

    if (!track) {
      return;
    }

    try {
      await playMusicTrack(session, guild, track);
    } catch (error) {
      console.error('Error reproduciendo musica:', error);

      if (track.textChannelId) {
        const channel = await guild.channels.fetch(track.textChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send(`No pude reproducir **${track.title}**: ${error.message}`);
        }
      }
    } finally {
      session.musicTaskScheduled = false;
      if (session.musicQueue.length > 0) {
        scheduleNextMusicTrack(session, guild);
      }
    }
  }, 'musica').catch(() => {});
}

function stopMusic(session) {
  const hadMusic = Boolean(session.currentTrack || session.musicQueue.length > 0 || session.musicTaskScheduled);
  session.musicQueue.length = 0;
  session.musicTaskScheduled = false;

  if (session.currentTrack) {
    session.player.stop(true);
    session.currentTrack = null;
  }

  return hadMusic;
}

function buildQueueMessage(session) {
  const lines = [];

  if (session?.currentTrack) {
    lines.push(`Sonando ahora: ${getTrackDisplay(session.currentTrack)}`);
  }

  if (session?.musicQueue?.length) {
    lines.push('Cola:');
    for (const [index, track] of session.musicQueue.slice(0, 10).entries()) {
      lines.push(`${index + 1}. ${track.title} (${formatDuration(track.duration)})`);
    }

    if (session.musicQueue.length > 10) {
      lines.push(`...y ${session.musicQueue.length - 10} mas.`);
    }
  }

  return lines.join('\n') || 'La cola esta vacia.';
}

async function replyLongMessage(message, text) {
  if (text.length <= 2000) {
    await message.reply(text);
    return;
  }

  const partes = text.match(/[\s\S]{1,2000}/g) || [];
  for (const parte of partes) {
    await message.reply(parte);
  }
}

async function registerGuildSlashCommands() {
  if (!COMMAND_GUILD_ID) {
    console.warn('No se registraron comandos slash porque falta COMMAND_GUILD_ID, DISCORD_GUILD_ID, GUILD_ID o SAY_GUILD_ID en el .env');
    return;
  }

  const guild = await client.guilds.fetch(COMMAND_GUILD_ID);
  await guild.commands.set([
    sayCommand,
    playCommand,
    queueCommand,
    skipCommand,
    stopCommand,
    leaveCommand,
    nowPlayingCommand,
  ]);
  console.log(`Comandos slash registrados en el servidor ${guild.name}`);
}

async function handleSayCommand(interaction) {
  if (interaction.guildId !== SAY_GUILD_ID) {
    await interaction.reply({
      content: 'Este comando solo esta habilitado en el servidor configurado.',
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: 'Necesitas el permiso Manage Messages para usar este comando.',
      ephemeral: true,
    });
    return;
  }

  const textToSend = interaction.options.getString('texto', true).trim();
  const targetChannel = await interaction.guild.channels.fetch(SAY_CHANNEL_ID).catch(() => null);

  if (!targetChannel || !targetChannel.isTextBased()) {
    await interaction.reply({
      content: 'No encontre el canal configurado para /say. Revisa SAY_CHANNEL_ID en el .env.',
      ephemeral: true,
    });
    return;
  }

  await targetChannel.send({
    content: textToSend,
    allowedMentions: {
      parse: ['users', 'roles'],
      repliedUser: false,
    },
  });

  await interaction.reply({
    content: `Mensaje enviado en ${targetChannel}.`,
    ephemeral: true,
  });
}

async function handlePlayCommand(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('consulta', true).trim();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const session = await joinMemberVoiceChannel(member);

  if (session.musicQueue.length >= MUSIC_QUEUE_LIMIT) {
    await interaction.editReply(`La cola esta llena. Limite actual: ${MUSIC_QUEUE_LIMIT} canciones.`);
    return;
  }

  const track = await resolveMusicQuery(query, interaction.user.id);
  track.textChannelId = interaction.channelId;

  session.musicQueue.push(track);
  scheduleNextMusicTrack(session, interaction.guild);

  const queuedAhead = session.musicQueue.length - 1;
  const statusText = session.currentTrack || queuedAhead > 0
    ? `Anadido a la cola: ${getTrackDisplay(track)}`
    : `Preparando: ${getTrackDisplay(track)}`;

  await interaction.editReply(`${statusText}\nFuente: ${track.source}`);
}

async function handleQueueCommand(interaction) {
  const session = getVoiceSession(interaction.guildId);
  await interaction.reply(buildQueueMessage(session));
}

async function handleNowPlayingCommand(interaction) {
  const session = getVoiceSession(interaction.guildId);

  if (!session?.currentTrack) {
    await interaction.reply('No hay ninguna cancion sonando ahora.');
    return;
  }

  await interaction.reply(`Sonando ahora: ${getTrackDisplay(session.currentTrack)}`);
}

async function handleSkipCommand(interaction) {
  const session = getVoiceSession(interaction.guildId);

  if (!session?.currentTrack) {
    await interaction.reply('No hay musica sonando para saltar.');
    return;
  }

  const skippedTitle = session.currentTrack.title;
  session.player.stop(true);
  await interaction.reply(`Saltada: **${skippedTitle}**`);
}

async function handleStopCommand(interaction) {
  const session = getVoiceSession(interaction.guildId);

  if (!session) {
    await interaction.reply('No estoy conectado a ningun canal de voz.');
    return;
  }

  const stopped = stopMusic(session);
  await interaction.reply(stopped ? 'Musica detenida y cola limpiada.' : 'No habia musica en cola.');
}

async function handleLeaveCommand(interaction) {
  const disconnected = leaveGuildVoice(interaction.guildId);
  await interaction.reply(disconnected ? 'Sali del canal de voz y limpie la cola.' : 'No estaba conectado a ningun canal de voz.');
}

client.on('guildMemberAdd', async (member) => {
  const canal = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!canal || !canal.isTextBased()) {
    return;
  }

  try {
    const respuesta = await groq.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Eres un pata peruano del servidor, hablas con jerga criolla y casual. Genera un mensaje de bienvenida corto, divertido y con jerga de barrio para un nuevo miembro.',
        },
        {
          role: 'user',
          content: `Dale bienvenida a ${member.user.username} al servidor`,
        },
      ],
      max_tokens: 200,
      temperature: 0.9,
    });

    const textoRespuesta = respuesta.choices?.[0]?.message?.content?.trim();
    if (!textoRespuesta) {
      return;
    }

    const avatarURL = member.user.displayAvatarURL({ size: 256, extension: 'png' });

    const embed = new EmbedBuilder()
      .setTitle('BIENVENIDO AL COAR LIMA PROVINCIAS')
      .setDescription(textoRespuesta)
      .setThumbnail(avatarURL)
      .setColor(0x00bfff)
      .setFooter({ text: `Ya somos ${member.guild.memberCount} patas en el server` })
      .setTimestamp();

    await canal.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error en bienvenida:', error);
  }
});

client.once('clientReady', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);

  try {
    await registerGuildSlashCommands();
  } catch (error) {
    console.error('Error registrando comandos slash:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === 'say') {
      await handleSayCommand(interaction);
    } else if (interaction.commandName === 'play') {
      await handlePlayCommand(interaction);
    } else if (interaction.commandName === 'queue') {
      await handleQueueCommand(interaction);
    } else if (interaction.commandName === 'nowplaying') {
      await handleNowPlayingCommand(interaction);
    } else if (interaction.commandName === 'skip') {
      await handleSkipCommand(interaction);
    } else if (interaction.commandName === 'stop') {
      await handleStopCommand(interaction);
    } else if (interaction.commandName === 'leave') {
      await handleLeaveCommand(interaction);
    }
  } catch (error) {
    console.error('Error en comando slash:', error);

    const response = {
      content: `Hubo un error: ${error.message}`,
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  const content = message.content.trim();
  const lower = content.toLowerCase();

  try {
    if (lower === `${BOT_PREFIX}join`) {
      const session = await joinMemberVoiceChannel(message.member);
      const channelName = message.guild.channels.cache.get(session.channelId)?.name || 'tu canal de voz';
      await message.reply(`Listo, ya entre a **${channelName}**.`);
      return;
    }

    if (lower === `${BOT_PREFIX}leave`) {
      const disconnected = leaveGuildVoice(message.guild.id);
      await message.reply(disconnected ? 'Sali del canal de voz.' : 'No estaba conectado a ningun canal de voz.');
      return;
    }

    if (lower.startsWith(`${BOT_PREFIX}say `)) {
      const textToSpeak = content.slice(`${BOT_PREFIX}say `.length).trim();
      if (!textToSpeak) {
        await message.reply(`Usa \`${BOT_PREFIX}say tu texto\``);
        return;
      }

      const session = await joinMemberVoiceChannel(message.member);
      await message.reply('Ya fue, lo digo en voz.');
      await speakInVoice(session, textToSpeak);
      return;
    }

    if (!message.mentions.has(client.user)) {
      return;
    }

    const texto = sanitizeMention(content);

    if (!texto) {
      await message.reply('Hola! En que te puedo ayudar?');
      return;
    }

    await message.channel.sendTyping();
    const textoRespuesta = await createGroqReply(message, texto);

    const stickers = message.guild.stickers.cache;
    const debeEnviarSticker = Math.random() < 0.1;
    if (stickers.size > 0 && debeEnviarSticker) {
      const stickerRandom = stickers.random();
      await message.channel.send({ stickers: [stickerRandom] });
    }

    await replyLongMessage(message, textoRespuesta);

    if (message.member.voice.channel) {
      const session = await joinMemberVoiceChannel(message.member);
      await speakInVoice(session, textoRespuesta);
    }
  } catch (error) {
    console.error('Error general:', error);
    await message.reply(`Hubo un error: ${error.message}`);
  }
});

client.login(DISCORD_TOKEN);
