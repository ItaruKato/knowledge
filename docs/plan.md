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

## 構成
- 画面：React + Vite + TypeScript（Watcher とそろえる）。Hosting のサイト `prtimes-knowledge`（target `knowledge`）
- 関数：まだなし。作るときは `functions/`、`firebase.json` の functions に `"codebase": "knowledge"`
- 自分のデータ：`kb` で始まるコレクション（ルールは prtimes-inbox の `firestore.rules` に足す）

## 受け取るデータの注意（コードを読んで分かったこと）
- `handoff` の `article.lead` は本文の冒頭 150 字まで。本文は入っていない（根拠に使うには本文を取り込む必要がある）
- `handoff` は読了にした記事だけ。読了を取り消しても消えない（`saved/{記事ID}.decision.status` が `done` かを確かめる）
- `drafts.industry` は仮の自由記述。業界タグ（30〜50種）はまだない
- `buckets` は 2026-10-01 以降（タイトル・冒頭150字・キーワード）。`companyArticles` は 2025-11-01 以降（タイトル・配信日時だけ）
- Watcher の AI 判定は止まっている（全記事に AI のタグはない）

## 進み具合
- [x] リポジトリのひな形（ログイン、受け取った記事の件数）
- [ ] 自動デプロイの許可（本人が Cloud Shell で）・承認済みドメイン（本人が Firebase コンソールで）
- [ ] 足りないことの決定（ネタ帳のテーマ、先行事例、質問への答え方、検索、MCP、レポートとメール）
- [ ] prtimes-inbox に `kb` のルールを足す
- [ ] 読んだ記事の取り込み・整理 → 画面（事例・ネタ帳）→ 会社ページ → 全記事と検索 → 質問 → レポート → MCP → パートナー
