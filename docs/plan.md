# Knowledge Base の計画

## 決まっていること（prtimes-inbox の docs/plan.md「Knowledge Base（④）」より）
- 用途：営業でのトーク、先行事例のインプット、会社のインプット
- 範囲：全記事（`buckets`・`companyArticles`）。本人が読んだ記事（`handoff`）とメモを優先
- 取り出し方：テーマ別のネタ帳、アプリ内の質問（記事を根拠に答える）、Claude のチャットから質問（MCP）
- レポート：デイリー（毎朝9時：昨日の注目記事＋今日の営業ネタ）、ウィークリー（日曜21時）。アプリ＋メール
- 先行事例の切り口：業界・テーマ・規模/段階・課題/狙い
- 会社ページ：PR TIMES 記事の時系列、調達・M&A の履歴、会社の基本情報、自分のメモと接点
- サービス：経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援
- 最初は本人だけ。後で社外パートナーを招待し、人ごとに見せる範囲を選ぶ
- AI は Claude（Secret Manager の `ANTHROPIC_API_KEY`）。予算は精度優先

## 本人が決めたこと（2026-11-12）
| 項目 | 決定 |
|---|---|
| 業界タグ | 台帳側（prtimes-inbox）に1つだけ置き、`companies` に書く。作るのは Long List のチャット。KB はそれまで AI の仮の業界を使う |
| 会社ページ | Knowledge Base が持つ。Long List からはリンク。Long List の温度感・進捗を読んで表示 |
| 分担の記録 | prtimes-inbox の docs/plan.md「Long List と Knowledge Base の分担」に書いた |
| 扱う深さ | 読んだ記事（handoff）は本文を取り込み AI で詳しく整理。それ以外はタイトル＋冒頭で軽く分類し、事例らしい記事だけ本文を取り込む |
| さかのぼり | 2026-10-01 以降（`buckets` にある分） |
| AI の予算 | 上限なし。使った額は毎週報告（レポートに入れる） |
| ネタ帳のテーマ | AI に任せる（記事から AI がテーマを作り、分ける） |
| 規模・段階 | スタートアップ（シード〜シリーズA）／成長期（シリーズB以降）／中小企業／中堅・大企業／上場企業 |
| 課題・狙い | 決まった選択肢（売上拡大・新規顧客の開拓・採用強化・資金確保・事業承継・海外展開・DX/効率化・ブランド など）＋AI の一言 |
| 事例の画面 | カード＋絞り込み と 業界×テーマの件数表 の両方 |
| 質問への答え | 結論 → 根拠の記事（タイトル・会社・日付・リンク）＋自分のメモの引用。一般知識も使ってよいが、記事の内容とは分けて表示する |
| 答えの速さ | 依頼（`kbJobs`）を書いた瞬間に動く関数（Firestore のトリガー）で処理。外から直接呼べる入口は作らない |
| 検索 | 意味で探す（Vertex AI で数値化し Firestore のベクトル検索）＋絞り込み。ベクトルの索引は prtimes-inbox の firestore.indexes.json に足す |
| MCP | ネット上に窓口を置き、Google ログイン（本人だけ）で守る。読むだけ。使う場所：claude.ai Web・スマホ・デスクトップ・Claude Code。**作る前に本人に設計を見せて確認を取る** |
| 朝の通知 | Watcher の通知はそのまま。KB のデイリーはメール＋アプリ |
| メール | 宛先は本人だけ。Google Workspace で DNS を触れる → 送り方はレポートを作るときに決める（候補：送信サービス＋送信用のサブドメイン） |
| 画面 | パソコンとスマホ半々（どちらでも使いやすく） |
| テーマのまとめ直し | 記事が増えて似たテーマがたまったら、AI がまとめ直す仕組みを足す（未着手） |
| まだ決めていない | ネタ1件の形（案：トーク例＋根拠の記事＋数字のカード）、質問の履歴（案：残す）、デイリー・ウィークリーの中身の細部 |

## 構成
- 画面：React + Vite + TypeScript（Watcher とそろえる）。Hosting のサイト `prtimes-knowledge`（target `knowledge`）
  - 住所：`/`（読んだ記事）、`/cases`（先行事例）、`/themes`・`/themes/{テーマ名}`（ネタ帳）。会社ページは `/c/{会社ID}` にする予定（Long List からのリンク先）
  - いまは kbArticles を一度に読み、絞り込みは画面の中で行う（src/lib/kb.ts）。全記事に広げるときは Firestore の問い合わせに移す
  - 本文は kbBodies に分けてある（一覧では読まない）
- 関数：`functions/`（codebase `knowledge`、関数名は `kb` で始める）。デプロイは GitHub Actions が `--only hosting:knowledge,functions:knowledge` で出す
  - `kbIngest`（10分ごと）：`handoff` を `updatedAt` の順に読み、読了の記事を `kbArticles` に取り込む。PR TIMES の記事ページから本文（最大2万字）を取り、台帳の会社の情報・本人のメモと一緒に AI（`claude-opus-5-5`、effort high）で整理する。テーマは AI が `kbThemes` から選び、なければ作る
  - 整理し直すのはタイトル・メモ・自分用タグが変わったときだけ（★・読んだ日時・Watcher の下書きだけなら写すだけ）。整理のしかたを変えたら `functions/src/analyze.ts` の `ANALYSIS_V` を上げる
  - 読了を取り消した記事は外す。AI が失敗した記事は次の回にやり直す（3回まで）
  - 使った量と費用の見積もりは `kbMeta/usage_{YYYYMMDD}`（ウィークリーで報告する）
- バージョン：画面の上と下に `v{package.json の version} · 最終更新 {ビルドした日時}`（GitHub Actions のビルドではコミット番号も）。機能を足したら package.json の version を上げる（0.x の2つ目の数字）。各カードには AI の整理の版（`ANALYSIS_V`）と整理した日時
- テスト：`npm test`（画面）、`cd functions && npm test`（関数）、`cd functions && npm run test:emulator`（Firestore エミュレーター。Java が必要）
- 自分のデータ：`kbArticles`・`kbCompanies`・`kbThemes`・`kbReports`・`kbMeta`（関数だけが書く）、`kbJobs`（画面からの依頼）、`kbConfig`（画面の設定）。ルールは prtimes-inbox の `firestore.rules` にある。新しいコレクションが要るときは、prtimes-inbox に足してから使う

## 受け取るデータの注意（コードを読んで分かったこと）
- `handoff` の `article.lead` は本文の冒頭 150 字まで。本文は入っていない（根拠に使うには本文を取り込む必要がある）
- `handoff` は読了にした記事だけ。読了を取り消しても消えない（`saved/{記事ID}.decision.status` が `done` かを確かめる）
- `drafts.industry` は仮の自由記述。業界タグ（30〜50種）はまだない
- `buckets` は 2026-10-01 以降（タイトル・冒頭150字・キーワード）。`companyArticles` は 2025-11-01 以降（タイトル・配信日時だけ）
- Watcher の AI 判定は止まっている（全記事に AI のタグはない）

## 進み具合
- [x] リポジトリのひな形（ログイン、受け取った記事の件数）
- [x] 自動デプロイの許可（Workload Identity）・承認済みドメイン（本人が設定済み）
- [x] 足りないことの決定（上の表）
- [x] prtimes-inbox に `kb` のルールを足す
- [x] 読んだ記事の取り込み・整理（`kbIngest`）と、整理した記事の一覧
- [x] 先行事例（カード＋4つの切り口の絞り込み・言葉で探す・業界×テーマの件数表）とネタ帳（サービスごとのテーマ → トーク例＋根拠の記事＋数字）（v0.4）
- [ ] 会社ページ → 全記事と検索 → 質問 → レポート → MCP → パートナー

## データの形（自分のコレクション）
- `kbArticles/{記事ID}`：v、id、companyId、source（handoff）、title・company・url・publishedAt、readAt、memo・myTags・stars（Watcher から写す）、draft（Watcher の AI の下書き）、bodyFrom（page / lead）、kb（industry・stage・stageReason・challenges・challengeNote・isCase・caseTitle・caseSummary・facts・talk）、themes（テーマ名の配列）、model、analyzedAt、analysisV、inputHash、state（done / failed）、tries、error
- `kbBodies/{記事ID}`：body（記事ページの本文、最大2万字。取れなければ冒頭）、from（page / lead）、at
- `kbThemes/{テーマ名}`：name、count（入っている記事の数）、service、description、by（ai）、createdAt・updatedAt
- `kbMeta/ingest`：cursor（handoff の updatedAt と記事ID）、lastRunAt、last（回ごとの件数）、total
- `kbMeta/usage_{YYYYMMDD}`：モデルごとのトークン数・requests、usd（見積もり）、by（用途ごとの回数）
- `kbMeta/lock_{name}`：重なって動かないための印
