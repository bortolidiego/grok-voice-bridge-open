import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as syntheticHarness from "./synthetic-mod-audio-stream.mjs";
import {
  analyzeWaveActiveRegion,
  buildCanonicalOriginateCommand,
  estimateFrequencyHz,
  isAllowedOriginateCommand,
  parseWaveFile,
  pcmAverageEnergy,
  pcmDurationMs,
  tonePcm24k,
} from "./synthetic-mod-audio-stream.mjs";

const RESULT_PATH = "/tmp/synthetic-test-result.json";
const cliTest = process.env.RUN_BIND_CLI_TESTS === "1" ? test : test.skip;

test("plano real cobre os quatro cenarios e isola cada gravacao", () => {
  const buildPlan = syntheticHarness.buildRealScenarioPlan;
  assert.equal(typeof buildPlan, "function", "buildRealScenarioPlan deve existir");

  const plan = buildPlan({ basePath: "/tmp/gvb-proof" });
  assert.deepEqual(plan.map((scenario) => scenario.name), [
    "known-tone-no-break",
    "empty-break-then-tone",
    "barge-in-after-play-before-chunk-played",
    "recorded-playback-proof",
  ]);
  assert.equal(new Set(plan.map((scenario) => scenario.recordingPath)).size, 4);
  assert.equal(plan[0].requireChunkPlayed, true);
  assert.equal(plan[1].breakWhen, "empty-queue");
  assert.equal(plan[1].expectedEmptyBreakOk, false);
  assert.equal(plan[2].breakWhen, "barge-in-after-play-before-chunk-played");
  assert.equal(plan[2].expectBreakSent, false);
  assert.equal(plan[2].expectBreakSkippedNoPlayback, 1);
  assert.equal(plan[3].requireRecordedPlayback, true);
});

test("allowlist aceita apenas originate loopback inline canonico", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(buildCanonicalOriginateCommand(uuid), "originate {origination_uuid=123e4567-e89b-42d3-a456-426614174000,loopback_bowout=false,STREAM_PLAYBACK=true}loopback/set:synthetic_test=true\\,answer\\,park/default/inline &echo()");
  assert.equal(isAllowedOriginateCommand(buildCanonicalOriginateCommand(uuid)), true);
});

test("allowlist bloqueia user, gateway, external, numeros PSTN, tech-prefix e shell", () => {
  assert.equal(isAllowedOriginateCommand("bgapi originate {origination_uuid=test-uuid}user/1000"), false);
  assert.equal(isAllowedOriginateCommand("originate {ignore_early_media=true}loopback/9999 XML default"), false);
  assert.equal(isAllowedOriginateCommand("originate {ignore_early_media=true}loopback/test-5511999999999 XML default"), false);
  assert.equal(isAllowedOriginateCommand("bgapi originate {x=y}sofia/gateway/exemplo/5511999999999"), false);
  assert.equal(isAllowedOriginateCommand("originate {x=y}loopback/9999 &bridge(sofia/external/+5511999999999@1.2.3.4)"), false);
  assert.equal(isAllowedOriginateCommand("originate {x=y}user/+5511999999999"), false);
  assert.equal(isAllowedOriginateCommand("originate {x=y}sip:1000@sip.voice.x.ai;transport=tls"), false);
  assert.equal(isAllowedOriginateCommand("originate {x=y}sofia/internal/test-agent; shutdown now"), false);
  assert.equal(isAllowedOriginateCommand("originate {origination_uuid=123e4567-e89b-42d3-a456-426614174000,foo=bar,loopback_bowout=false}loopback/answer,park/default/inline &park()"), false);
  assert.equal(isAllowedOriginateCommand("originate {origination_uuid=123e4567-e89b-42d3-a456-426614174000,loopback_bowout=false}loopback/answer,park/default/inline &park() extra"), false);
  assert.equal(isAllowedOriginateCommand("originate {origination_uuid=not-a-uuid,loopback_bowout=false}loopback/answer,park/default/inline &park()"), false);
});

test.skip("analise de tom", () => {
  const pcm = tonePcm24k(440, 1000);
  assert.ok(pcmAverageEnergy(pcm) > 5000);
  assert.ok(Math.abs(pcmDurationMs(pcm, 16000) - 1000) < 1);
  assert.ok(Math.abs(estimateFrequencyHz(pcm, 16000) - 440) < 10);
});

function makeWave({ pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16 }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write("fmt ", 0, "ascii");
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8);
  fmtChunk.writeUInt16LE(channels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(byteRate, 16);
  fmtChunk.writeUInt16LE(blockAlign, 20);
  fmtChunk.writeUInt16LE(bitsPerSample, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + fmtChunk.length + dataHeader.length + pcm.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, fmtChunk, dataHeader, pcm]);
}

test.skip("parser WAV", () => {
  const silence = Buffer.alloc(1600 * 2, 0);
  const tone = tonePcm24k(440, 1000);
  const wav = makeWave({ pcm: Buffer.concat([silence, tone, silence]), sampleRate: 16000 });

  const parsed = parseWaveFile(wav);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.data.length, silence.length * 2 + tone.length);

  const analysis = analyzeWaveActiveRegion(wav);
  assert.ok(analysis.energy > 5000);
  assert.ok(Math.abs(analysis.activeDurationMs - 1000) < 80);
  assert.ok(Math.abs(analysis.frequencyHz - 440) < 15);
});

cliTest("CLI fake imprime JSON, grava result e sai 0 quando passed=true", () => {
  if (existsSync(RESULT_PATH)) rmSync(RESULT_PATH);

  const child = spawnSync(process.execPath, ["test/synthetic-mod-audio-stream.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, MODE: "fake" },
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(child.stdout.trim().startsWith("{"), `stdout sem JSON: ${child.stdout}`);

  const payload = JSON.parse(child.stdout);
  assert.equal(payload.mode, "fake");
  assert.equal(payload.passed, true);

  assert.equal(existsSync(RESULT_PATH), true, "arquivo de resultado nao foi gravado");
  const saved = JSON.parse(readFileSync(RESULT_PATH, "utf8"));
  assert.equal(saved.mode, "fake");
  assert.equal(saved.passed, true);
});
