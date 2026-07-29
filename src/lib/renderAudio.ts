/**
 * Decode source media audio and encode Opus packets for webm-muxer.
 */

const AUDIO_BITRATE = 128_000;

export interface RenderAudioSource {
  url: string;
  speed: number;
  volume: number;
}

export interface EncodedAudioTrack {
  sampleRate: number;
  numberOfChannels: number;
  chunks: { data: Uint8Array; timestamp: number; type: "key" | "delta"; duration: number }[];
}

async function decodeUrl(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch audio (${response.status})`);
  const raw = await response.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(raw.slice(0));
  } finally {
    void ctx.close();
  }
}

/** Mix sources into a mono/stereo buffer covering [0, durationSec]. */
export async function mixRenderAudio(
  sources: RenderAudioSource[],
  durationSec: number,
): Promise<AudioBuffer | null> {
  if (sources.length === 0 || durationSec <= 0) return null;

  const decoded: { buffer: AudioBuffer; speed: number; volume: number }[] = [];
  for (const source of sources) {
    try {
      const buffer = await decodeUrl(source.url);
      decoded.push({ buffer, speed: source.speed, volume: source.volume });
    } catch (err) {
      console.warn("Skipping audio source for render:", source.url, err);
    }
  }
  if (decoded.length === 0) return null;

  const sampleRate = decoded[0]!.buffer.sampleRate;
  const numberOfChannels = Math.min(
    2,
    Math.max(...decoded.map((d) => d.buffer.numberOfChannels)),
  );
  const length = Math.max(1, Math.ceil(durationSec * sampleRate));
  const offline = new OfflineAudioContext(numberOfChannels, length, sampleRate);

  for (const { buffer, speed, volume } of decoded) {
    const node = offline.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = speed;
    const gain = offline.createGain();
    gain.gain.value = volume;
    node.connect(gain);
    gain.connect(offline.destination);
    node.start(0);
  }

  return offline.startRendering();
}

export async function encodeAudioBufferOpus(
  buffer: AudioBuffer,
): Promise<EncodedAudioTrack | null> {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") {
    return null;
  }

  const sampleRate = buffer.sampleRate;
  const numberOfChannels = Math.min(2, buffer.numberOfChannels);
  const codec = "opus";

  const support = await AudioEncoder.isConfigSupported({
    codec,
    sampleRate,
    numberOfChannels,
    bitrate: AUDIO_BITRATE,
  });
  if (!support.supported) return null;

  const chunks: EncodedAudioTrack["chunks"] = [];
  let encodeError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        timestamp: chunk.timestamp,
        type: chunk.type,
        duration: chunk.duration ?? Math.round((1_000_000 * 1024) / sampleRate),
      });
    },
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });

  encoder.configure({
    codec,
    sampleRate,
    numberOfChannels,
    bitrate: AUDIO_BITRATE,
  });

  // Feed ~20ms frames of planar f32.
  const frameSamples = Math.max(1, Math.round(sampleRate / 50));
  const total = buffer.length;
  const planes: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    planes.push(buffer.getChannelData(ch));
  }

  for (let offset = 0; offset < total; offset += frameSamples) {
    const count = Math.min(frameSamples, total - offset);
    const data = new Float32Array(count * numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch += 1) {
      const src = planes[ch]!;
      for (let i = 0; i < count; i += 1) {
        data[i * numberOfChannels + ch] = src[offset + i] ?? 0;
      }
    }

    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: count,
      numberOfChannels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
  }

  await encoder.flush();
  encoder.close();

  if (encodeError) throw encodeError;
  if (chunks.length === 0) return null;

  return { sampleRate, numberOfChannels, chunks };
}
