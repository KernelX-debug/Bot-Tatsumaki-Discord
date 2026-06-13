require('dotenv').config();

const { spawn } = require('node:child_process');
const { constants: FsConstants } = require('node:fs');
const { access, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { PassThrough } = require('node:stream');
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
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const Groq = require('groq-sdk');
const WavDecoder = require('wav-decoder');
const { default: YTDlpWrap } = require('yt-dlp-wrap');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1328382983547387999';
const SAY_GUILD_ID = process.env.SAY_GUILD_ID || process.env.DISCORD_GUILD_ID || process.env.GUILD_ID;
const SAY_CHANNEL_ID = process.env.SAY_CHANNEL_ID || WELCOME_CHANNEL_ID;
const BOT_PREFIX = '!';
const CHAT_MODEL = 'llama-3.1-8b-instant';
const TTS_MODEL = 'canopylabs/orpheus-v1-english';
const TTS_VOICE = 'diana';
const MAX_TTS_CHARS = 200;
const YTDLP_BINARY_PATH = process.env.YT_DLP_PATH || path.join(
  __dirname,
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

if (!DISCORD_TOKEN) {
  throw new Error('Falta DISCORD_TOKEN en el archivo .env');
}

if (!GROQ_API_KEY) {
  console.warn('Falta GROQ_API_KEY en el archivo .env. La IA y el TTS quedan desactivados, pero el bot y la musica pueden funcionar.');
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

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const ytDlp = new YTDlpWrap(YTDLP_BINARY_PATH);
let ytDlpReady = null;
const conversaciones = new Map();
const voiceSessions = new Map();

function ensureGroqAvailable(featureName = 'Esta funcion') {
  if (!groq) {
    throw new Error(`${featureName} necesita GROQ_API_KEY en el archivo .env.`);
  }
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
  ensureGroqAvailable('La IA');

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

async function fileExists(filePath) {
  try {
    await access(filePath, FsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureYtDlpBinary() {
  if (!ytDlpReady) {
    ytDlpReady = (async () => {
      if (await fileExists(YTDLP_BINARY_PATH)) {
        return;
      }

      await mkdir(path.dirname(YTDLP_BINARY_PATH), { recursive: true });
      console.log(`Descargando yt-dlp en ${YTDLP_BINARY_PATH}...`);
      await YTDlpWrap.downloadFromGithub(YTDLP_BINARY_PATH);
      console.log('yt-dlp listo para reproducir musica.');
    })();
  }

  await ytDlpReady;
}

async function runYtDlp(args) {
  await ensureYtDlpBinary();
  return ytDlp.execPromise(args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 20,
  });
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
      musicLoop: null,
      nowPlaying: null,
      isMusicPlaying: false,
      ffmpegProcess: null,
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
  cleanupMusicProcess(session);
  session.player.stop(true);
  session.connection.destroy();
  voiceSessions.delete(guildId);
  return true;
}

function hasActiveMusic(session) {
  return Boolean(session?.musicLoop || session?.isMusicPlaying || session?.nowPlaying || session?.musicQueue?.length);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '?:??';
  }

  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const rest = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function cleanupMusicProcess(session) {
  if (!session?.ffmpegProcess) {
    return;
  }

  if (!session.ffmpegProcess.killed) {
    session.ffmpegProcess.kill('SIGKILL');
  }

  session.ffmpegProcess = null;
}

async function searchSong(query, requestedBy) {
  const stdout = await runYtDlp([
    '--dump-single-json',
    '--default-search',
    'ytsearch1',
    '--format',
    'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    query,
  ]);

  const info = JSON.parse(stdout);
  const song = Array.isArray(info.entries) ? info.entries.find(Boolean) : info;

  if (!song) {
    return null;
  }

  const webpageUrl = song.webpage_url || song.original_url || song.url;
  if (!webpageUrl) {
    return null;
  }

  return {
    title: song.title || query,
    webpageUrl,
    duration: Number.isFinite(song.duration) ? song.duration : null,
    requestedBy,
  };
}

async function getSongStreamUrl(song) {
  const stdout = await runYtDlp([
    '--get-url',
    '--format',
    'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    song.webpageUrl,
  ]);

  const urls = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return urls.at(-1) || null;
}

function createMusicResource(session, audioUrl) {
  cleanupMusicProcess(session);

  const ffmpegProcess = spawn(ffmpeg.path, [
    '-nostdin',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-i',
    audioUrl,
    '-analyzeduration',
    '0',
    '-loglevel',
    'warning',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1',
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  session.ffmpegProcess = ffmpegProcess;

  let stderr = '';
  ffmpegProcess.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });

  ffmpegProcess.on('close', (code) => {
    if (code && code !== 255) {
      console.warn(`FFmpeg termino con codigo ${code}: ${stderr.trim()}`);
    }
  });

  return createAudioResource(ffmpegProcess.stdout, {
    inputType: StreamType.Raw,
  });
}

function waitForPlayerIdle(player) {
  return new Promise((resolve, reject) => {
    const onIdle = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once('error', onError);
  });
}

async function playMusicSong(session, song) {
  const audioUrl = await getSongStreamUrl(song);
  if (!audioUrl) {
    throw new Error('No pude obtener el enlace de audio.');
  }

  const resource = createMusicResource(session, audioUrl);
  session.nowPlaying = song;
  session.isMusicPlaying = true;
  session.player.play(resource);

  await entersState(session.player, AudioPlayerStatus.Playing, 20_000);
  await waitForPlayerIdle(session.player);
}

function startMusicLoop(session, textChannel) {
  if (session.musicLoop) {
    return;
  }

  session.musicLoop = (async () => {
    while (session.musicQueue.length > 0) {
      const song = session.musicQueue.shift();

      try {
        await textChannel.send(`Reproduciendo: **${song.title}** (${formatDuration(song.duration)})`);
        await playMusicSong(session, song);
      } catch (error) {
        console.error('Error reproduciendo musica:', error);
        await textChannel.send(`No pude reproducir **${song.title}**: ${error.message}`);
      } finally {
        cleanupMusicProcess(session);
        session.nowPlaying = null;
        session.isMusicPlaying = false;
      }
    }
  })().catch((error) => {
    console.error('Error en la cola de musica:', error);
  }).finally(() => {
    cleanupMusicProcess(session);
    session.musicLoop = null;
    session.nowPlaying = null;
    session.isMusicPlaying = false;
  });
}

function buildQueueMessage(session) {
  const lines = [];

  if (session.nowPlaying) {
    lines.push(`Ahora: **${session.nowPlaying.title}** (${formatDuration(session.nowPlaying.duration)})`);
  }

  if (session.musicQueue.length === 0) {
    lines.push('Cola vacia.');
  } else {
    lines.push('Cola:');
    for (const [index, song] of session.musicQueue.slice(0, 10).entries()) {
      lines.push(`${index + 1}. ${song.title} (${formatDuration(song.duration)})`);
    }

    if (session.musicQueue.length > 10) {
      lines.push(`...y ${session.musicQueue.length - 10} mas.`);
    }
  }

  return lines.join('\n');
}

function stopMusic(session, clearQueue = false) {
  if (clearQueue) {
    session.musicQueue.length = 0;
  }

  cleanupMusicProcess(session);
  session.player.stop(true);
}

async function synthesizeSpeechToBuffer(text) {
  ensureGroqAvailable('El TTS');

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

async function createPcmResourceFromWavBuffer(wavBuffer) {
  const decoded = await WavDecoder.decode(wavBuffer);

  if (decoded.sampleRate !== 48000) {
    throw new Error(`La voz de Groq devolvio ${decoded.sampleRate}Hz y Discord necesita 48000Hz.`);
  }

  const left = decoded.channelData[0];
  const right = decoded.channelData[1] || decoded.channelData[0];
  const pcmBuffer = Buffer.alloc(left.length * 4);

  for (let i = 0; i < left.length; i += 1) {
    const leftSample = Math.max(-1, Math.min(1, left[i]));
    const rightSample = Math.max(-1, Math.min(1, right[i]));
    const leftInt = leftSample < 0 ? leftSample * 0x8000 : leftSample * 0x7fff;
    const rightInt = rightSample < 0 ? rightSample * 0x8000 : rightSample * 0x7fff;

    pcmBuffer.writeInt16LE(Math.round(leftInt), i * 4);
    pcmBuffer.writeInt16LE(Math.round(rightInt), (i * 4) + 2);
  }

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
  if (hasActiveMusic(session)) {
    throw new Error('Estoy reproduciendo musica. Usa !stop o espera a que termine antes de usar voz TTS.');
  }

  const chunks = splitForTts(text);

  if (chunks.length === 0) {
    return;
  }

  session.queue = session.queue.then(async () => {
    for (const chunk of chunks) {
      await playSpeechChunk(session, chunk);
    }
  }).catch((error) => {
    console.error('Error en la cola de voz:', error);
  });

  await session.queue;
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
  if (!SAY_GUILD_ID) {
    console.warn('No se registro /say porque falta SAY_GUILD_ID en el .env');
    return;
  }

  const guild = await client.guilds.fetch(SAY_GUILD_ID);
  await guild.commands.set([sayCommand]);
  console.log(`Comando /say registrado en el servidor ${guild.name}`);
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

client.on('guildMemberAdd', async (member) => {
  const canal = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!canal || !canal.isTextBased()) {
    return;
  }

  try {
    let textoRespuesta = `Bienvenido ${member.user.username} al servidor. Ponte comodo y pasa la voz.`;

    if (groq) {
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

      textoRespuesta = respuesta.choices?.[0]?.message?.content?.trim() || textoRespuesta;
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

    if (lower.startsWith(`${BOT_PREFIX}play `) || lower.startsWith(`${BOT_PREFIX}p `)) {
      const usedPrefix = lower.startsWith(`${BOT_PREFIX}play `) ? `${BOT_PREFIX}play ` : `${BOT_PREFIX}p `;
      const query = content.slice(usedPrefix.length).trim();

      if (!query) {
        await message.reply(`Usa \`${BOT_PREFIX}play nombre o enlace\``);
        return;
      }

      const session = await joinMemberVoiceChannel(message.member);
      await message.reply(`Buscando: **${query}**...`);

      const song = await searchSong(query, message.author.id);
      if (!song) {
        await message.reply('No encontre resultados.');
        return;
      }

      session.musicQueue.push(song);
      await message.reply(`Anadido a la cola: **${song.title}** (${formatDuration(song.duration)})`);
      startMusicLoop(session, message.channel);
      return;
    }

    if (lower === `${BOT_PREFIX}queue` || lower === `${BOT_PREFIX}cola`) {
      const session = getVoiceSession(message.guild.id);
      await message.reply(session ? buildQueueMessage(session) : 'No hay musica en cola.');
      return;
    }

    if (lower === `${BOT_PREFIX}skip`) {
      const session = getVoiceSession(message.guild.id);
      if (!session || !session.nowPlaying) {
        await message.reply('No hay musica reproduciendose.');
        return;
      }

      stopMusic(session, false);
      await message.reply('Cancion omitida.');
      return;
    }

    if (lower === `${BOT_PREFIX}stop`) {
      const session = getVoiceSession(message.guild.id);
      if (!session || !hasActiveMusic(session)) {
        await message.reply('No hay musica para detener.');
        return;
      }

      stopMusic(session, true);
      await message.reply('Musica detenida y cola vaciada.');
      return;
    }

    if (lower.startsWith(`${BOT_PREFIX}say `)) {
      const textToSpeak = content.slice(`${BOT_PREFIX}say `.length).trim();
      if (!textToSpeak) {
        await message.reply(`Usa \`${BOT_PREFIX}say tu texto\``);
        return;
      }

      const session = await joinMemberVoiceChannel(message.member);
      if (hasActiveMusic(session)) {
        await message.reply('Estoy reproduciendo musica. Usa `!stop` o espera a que termine antes de usar voz TTS.');
        return;
      }

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

    if (!groq) {
      await message.reply('La IA esta desactivada porque falta GROQ_API_KEY en el .env, pero los comandos de musica siguen funcionando.');
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
      if (!hasActiveMusic(session)) {
        await speakInVoice(session, textoRespuesta);
      }
    }
  } catch (error) {
    console.error('Error general:', error);
    await message.reply(`Hubo un error: ${error.message}`);
  }
});

client.login(DISCORD_TOKEN);
