# Knowledge Base（ItaruKato/knowledge）

読んだ記事を営業の知識として体系化するアプリ。PR Times Watcher（ItaruKato/prtimes-inbox）と同じ Firebase プロジェクト `prtimes-inbox`（asia-northeast1）を使う、別のリポジトリ・別のサイト（https://prtimes-knowledge.web.app）。

作業の前に必ず読む：
- `docs/plan.md`（このアプリの計画と決まったこと）
- prtimes-inbox の `docs/plan.md`（特に「データの置き場所」「共有の決まり（上書き事故を防ぐ）」）

## 必ず守ること（要点）
- Firestore のルール・索引は prtimes-inbox の `firestore.rules`・`firestore.indexes.json` だけで管理する。このリポジトリに firestore の設定を置かない・デプロイしない。
- デプロイは `--only hosting:knowledge`（関数ができたら `functions:knowledge` も）だけ。Functions の codebase は `knowledge`。
- `handoff`・`drafts`・`notes`・`companies`・`companyArticles`・`buckets` は読むだけ。書くのは `kb` で始まる自分のコレクションだけ。
- 画面から関数を直接呼ばない（誰でも呼べる関数を作らない）。依頼は Firestore に書いて関数が処理する。
- 秘密情報は Secret Manager だけ。リポジトリは公開：ログ・コミット・docs に記事・メモ・営業先の情報を出さない（件数だけ）。
- 権限の変更（Workload Identity・承認済みドメインなど）は本人の操作。Cloud Shell に貼るコマンドで案内する。
- prtimes-inbox を直すときは直前に pull し、テストとビルドを通してから push。直すのは必要最小限。Watcher・台帳の処理を変えるときは先に本人に相談する。
- コミットの作成者は `Claude <noreply@anthropic.com>`。モデル名はコミット・PR に書かない。
- 本人は開発の素人。手順は1つずつ分かりやすく、決めることは質問形式で聞く。
