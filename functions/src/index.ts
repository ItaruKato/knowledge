import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import Anthropic from '@anthropic-ai/sdk';
import { ingestSweep } from './ingest';
import { runJob } from './jobs';
import { indexSweep } from './allindex';
import { vertexEmbed } from './vertex';
import { dailyReport, weeklyReport } from './reports';
import { resendSender } from './mail';

/**
 * Knowledge Base の Cloud Functions（codebase: knowledge）。
 * 関数名は kb で始める（Watcher の関数と名前がぶつからないように）。
 * 外から呼べる関数は作らない（スケジュールと Firestore の書き込みで動く）。
 */
initializeApp();
const db = getFirestore();

const common = { region: 'asia-northeast1', timeZone: 'Asia/Tokyo' } as const;
const anthropicKey = defineSecret('ANTHROPIC_API_KEY');
/** レポートのメール（Resend。送信だけの権限のキー） */
const resendKey = defineSecret('RESEND_API_KEY');
const sender = () => resendSender(resendKey.value());
const claude = () => new Anthropic({ apiKey: anthropicKey.value(), maxRetries: 2, timeout: 180_000 });

/** 読了にした記事（handoff）を取り込み、本文を読んで AI で整理する（10分ごと） */
export const kbIngest = onSchedule(
  { ...common, schedule: 'every 10 minutes', timeoutSeconds: 540, memory: '512MiB', secrets: [anthropicKey] },
  async () => {
    await ingestSweep({ db, client: claude, embed: vertexEmbed, log: (msg, data) => logger.info(msg, data) });
  },
);

/**
 * 画面・取り込みからの依頼（kbJobs）を、書かれた瞬間に処理する（会社ページの AI のまとめなど）。
 * Firestore の書き込みで動くだけで、外から呼べる入口ではない。届かなかった分は kbIngest が拾う。
 */
export const kbJobRun = onDocumentCreated(
  { document: 'kbJobs/{jobId}', region: 'asia-northeast1', timeoutSeconds: 300, memory: '512MiB', secrets: [anthropicKey, resendKey], retry: false },
  async (event) => {
    if (!event.data) return;
    await runJob({ db, client: claude, embed: vertexEmbed, send: sender(), log: (msg, data) => logger.info(msg, data) }, event.data.ref);
  },
);

/**
 * 全記事の目録（2026-09-01 以降の全記事。10分ごとに少しずつ）：buckets を読み、セミナーなどを外し、
 * Vertex AI で数値にし（意味で探すため）、Claude（Opus。まとめて処理する仕組みで半額）で種類・業界・事例らしさを分類する
 */
export const kbIndexSweep = onSchedule(
  { ...common, schedule: 'every 10 minutes', timeoutSeconds: 540, memory: '1GiB', secrets: [anthropicKey] },
  async () => {
    await indexSweep({ db, client: claude, embed: vertexEmbed, log: (msg, data) => logger.info(msg, data) });
  },
);

/** デイリー（毎朝9時に読めるよう 8:55 に作る）：昨日の注目記事と今日の営業ネタ3つ */
export const kbDailyReport = onSchedule(
  { ...common, schedule: '55 8 * * *', timeoutSeconds: 540, memory: '1GiB', secrets: [anthropicKey, resendKey], retryCount: 1 },
  async () => {
    const r = await dailyReport({ db, client: claude, send: sender() });
    logger.info('kb daily report', r);
  },
);

/** ウィークリー（日曜21時に読めるよう 20:55 に作る）：今週のふりかえり・事例ベスト・来週動くとよい会社・AI の費用 */
export const kbWeeklyReport = onSchedule(
  { ...common, schedule: '55 20 * * 0', timeoutSeconds: 540, memory: '1GiB', secrets: [anthropicKey, resendKey], retryCount: 1 },
  async () => {
    const r = await weeklyReport({ db, client: claude, send: sender() });
    logger.info('kb weekly report', r);
  },
);
