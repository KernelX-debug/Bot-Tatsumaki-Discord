import discord
from discord.ext import commands
import yt_dlp
import asyncio
import os

# =========================
# CONFIGURACIÓN
# =========================

TOKEN = os.getenv("DISCORD_TOKEN")

if not TOKEN:
    raise RuntimeError("Falta DISCORD_TOKEN en las variables de entorno.")

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(
    command_prefix="t!",
    intents=intents
)

# =========================
# VARIABLES GLOBALES
# =========================

music_queue = []

YDL_OPTIONS = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "quiet": True,
    "extract_flat": False
}

FFMPEG_OPTIONS = {
    "before_options": "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
    "options": "-vn"
}

# =========================
# EVENTOS
# =========================

@bot.event
async def on_ready():
    print(f"Bot conectado como {bot.user}")

# =========================
# BUSCAR CANCIÓN
# =========================

def search_song(query):
    try:
        with yt_dlp.YoutubeDL(YDL_OPTIONS) as ydl:

            results = ydl.extract_info(
                f"ytsearch:{query}",
                download=False
            )

            if not results["entries"]:
                return None

            song = results["entries"][0]

            return {
                "title": song["title"],
                "url": song["url"]
            }

    except Exception as e:
        print(e)
        return None

# =========================
# REPRODUCIR SIGUIENTE
# =========================

async def play_next(ctx):

    if len(music_queue) == 0:
        return

    song = music_queue.pop(0)

    try:

        source = await discord.FFmpegOpusAudio.from_probe(
            song["url"],
            **FFMPEG_OPTIONS
        )

        ctx.voice_client.play(
            source,
            after=lambda error: asyncio.run_coroutine_threadsafe(
                play_next(ctx),
                bot.loop
            )
        )

        await ctx.send(
            f"🎵 Reproduciendo: **{song['title']}**"
        )

    except Exception as e:
        print(e)
        await play_next(ctx)

# =========================
# t!join
# =========================

@bot.command()
async def join(ctx):

    if not ctx.author.voice:
        await ctx.send(
            "❌ Debes estar en un canal de voz."
        )
        return

    channel = ctx.author.voice.channel

    if ctx.voice_client:

        if ctx.voice_client.channel == channel:
            await ctx.send(
                "✅ Ya estoy conectado a tu canal."
            )
            return

        await ctx.voice_client.move_to(channel)

    else:
        await channel.connect()

    await ctx.send(
        f"✅ Conectado a **{channel.name}**"
    )

# =========================
# t!play
# =========================

@bot.command()
async def play(ctx, *, query):

    if not ctx.author.voice:
        await ctx.send(
            "❌ Debes estar conectado a un canal de voz."
        )
        return

    if not ctx.voice_client:
        await ctx.author.voice.channel.connect()

    await ctx.send(
        f"🔎 Buscando: **{query}**..."
    )

    song = search_song(query)

    if not song:
        await ctx.send(
            "❌ No encontré resultados."
        )
        return

    music_queue.append(song)

    await ctx.send(
        f"➕ Añadido a la cola: **{song['title']}**"
    )

    if not ctx.voice_client.is_playing():
        await play_next(ctx)

# =========================
# t!queue
# =========================

@bot.command(name="queue")
async def queue_command(ctx):

    if len(music_queue) == 0:
        await ctx.send(
            "📭 La cola está vacía."
        )
        return

    message = "📋 Cola actual:\n\n"

    for index, song in enumerate(music_queue, start=1):
        message += f"{index}. {song['title']}\n"

    await ctx.send(message)

# =========================
# t!skip
# =========================

@bot.command()
async def skip(ctx):

    if not ctx.voice_client:
        await ctx.send(
            "❌ No estoy conectado."
        )
        return

    if not ctx.voice_client.is_playing():
        await ctx.send(
            "❌ No hay música reproduciéndose."
        )
        return

    ctx.voice_client.stop()

    await ctx.send(
        "⏭ Canción omitida."
    )

# =========================
# t!leave
# =========================

@bot.command()
async def leave(ctx):

    music_queue.clear()

    if ctx.voice_client:

        await ctx.voice_client.disconnect()

        await ctx.send(
            "👋 Bot desconectado."
        )

# =========================
# EJECUTAR BOT
# =========================

bot.run(TOKEN)
