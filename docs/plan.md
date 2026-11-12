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
| さかのぼり | 2026-09-01 以降（Watcher の取り込み範囲に合わせる。2026-11-12 に 10-01 から変更） |
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
| HP・Web 検索 | 費用対効果のため、本人が指示したときだけ（会社ページの「HP から肉付け」ボタン。依頼に manual: true）。自動では依頼しない（2026-11-12 本人の決定） |
| 知識のつながり | 丸は会社＋テーマ＋業界。共通点で結び、⑤で意味の近さも足す。3D と 2D を切り替え。押した丸：周りを光らせる・横に要点・会社ページ/ネタ帳へ・中心に広げる（2026-11-12 本人の決定） |
| まだ決めていない | ネタ1件の形（案：トーク例＋根拠の記事＋数字のカード）、質問の履歴（案：残す）、デイリー・ウィークリーの中身の細部 |

## 構成
- 画面：React + Vite + TypeScript（Watcher とそろえる）。Hosting のサイト `prtimes-knowledge`（target `knowledge`）
  - 住所：`/`（読んだ記事）、`/cases`（先行事例）、`/themes`・`/themes/{テーマ名}`（ネタ帳）、`/companies`（読んだ記事のある会社）、`/c/{会社ID}`（会社ページ。Long List からのリンク先。会社IDは PR TIMES の会社ID）、`/graph`（知識のつながり）
  - いまは kbArticles を一度に読み、絞り込みは画面の中で行う（src/lib/kb.ts）。全記事に広げるときは Firestore の問い合わせに移す
  - 本文は kbBodies に分けてある（一覧では読まない）
  - 会社名の表示（src/lib/names.ts）：正式名（法人格を含む）が分かれば PR TIMES の会社名の代わりに出す。1. 会社 HP の正式名（companies.web.officialName。法人格を含み、PR TIMES の名前と同じ会社と分かるとき）→ 2. gBizINFO の正式名（companies.gbiz.name）→ 3. PR TIMES の会社名。台帳の name は書き換えない。会社ページでは PR TIMES での名前も小さく添える
  - 知識のつながり（v0.9、src/lib/graph.ts・src/pages/GraphPage.tsx）：会社・テーマ・業界の丸と線。3D（3d-force-graph／three.js）と 2D（force-graph）を切り替え（どちらにしたかは端末に覚える）。3D の部品は大きいので、このタブを開いたときだけ読み込む
    - 線：会社─テーマ、会社─業界、似ている会社どうし（共通点の点数：同じテーマ3・同じ業界2・同じ課題/狙い1・同じ規模/段階1。3点以上、1社6本まで。理由つき）。追加の AI は使わない（本人の決定）。⑤で「意味の近さ」の線を足す
    - 丸を押す：つながる丸だけ光らせ、横に要点（会社：読んだ記事・トーク例・似ている会社と理由・テーマ／テーマ・業界：つながる会社）、会社ページ・ネタ帳へ、「ここを中心に広げる」（2歩先まで）。検索窓の言葉に当てはまる丸も光らせる
  - 検索窓（v0.8）：タブの下に1つ。言葉はタブを切り替えても残り、× ボタン（または Esc）で一度に消せる。読んだ記事・先行事例・ネタ帳（テーマとネタ）・会社の一覧・会社ページの PR TIMES の記事を絞る。正式な会社名でも探せる
  - 見た目（v0.7）：色の名前は Watcher とそろえ、文字と背景の差を大きくした（補足の文字も 4.5:1 以上）。カードは「課題・狙い」「トーク例」「自分のメモ」に見出しを付け、業界（青）・規模/段階（緑）・課題（黄）で色を分ける
- 関数：`functions/`（codebase `knowledge`、関数名は `kb` で始める）。デプロイは GitHub Actions が `--only hosting:knowledge,functions:knowledge` で出す
  - `kbIngest`（10分ごと）：`handoff` を `updatedAt` の順に読み、読了の記事を `kbArticles` に取り込む。PR TIMES の記事ページから本文（最大2万字）を取り、台帳の会社の情報・本人のメモと一緒に AI（`claude-opus-5-5`、effort high）で整理する。テーマは AI が `kbThemes` から選び、なければ作る
  - 整理し直すのはタイトル・メモ・自分用タグが変わったときだけ（★・読んだ日時・Watcher の下書きだけなら写すだけ）。整理のしかたを変えたら `functions/src/analyze.ts` の `ANALYSIS_V` を上げる
  - 読了を取り消した記事は外す。AI が失敗した記事は次の回にやり直す（3回まで）
  - 使った量と費用の見積もりは `kbMeta/usage_{YYYYMMDD}`（ウィークリーで報告する）
  - 記事を整理したら、その会社のまとめの依頼（`kbJobs`、type company）を足す。HP の読み込みは自動では依頼しない（本人がボタンで指示したときだけ、画面が `webQueue/{会社ID}` に manual: true で依頼する。処理は prtimes-inbox の companyWebSweep）
  - `kbJobRun`（Firestore の kbJobs に依頼が書かれた瞬間に動く。外から呼べる入口ではない）：会社ページの AI のまとめ（`kbCompanies`）。材料が同じならまとめ直さない（画面の「まとめ直す」は作り直す）。届かなかった依頼は kbIngest が拾い、1日たった依頼は消す
  - 会社のまとめの材料：台帳（companies・companyArticles のタイトルと日付、300件まで）、読んだ記事の整理とメモ、Long List（longlist/{会社ID} があれば）。出来事（調達・M&A など）は根拠の記事IDつき。一覧にないIDは捨てる
- バージョン：画面の上と下に `v{package.json の version} · 最終更新 {ビルドした日時}`（GitHub Actions のビルドではコミット番号も）。機能を足したら package.json の version を上げる（0.x の2つ目の数字）。各カードには AI の整理の版（`ANALYSIS_V`）と整理した日時
- 権限（本人が 2026-11-12 に Cloud Shell で付けた。Firestore のトリガー kbJobRun に必要）：Pub/Sub のサービスエージェントに `roles/iam.serviceAccountTokenCreator`、既定のコンピュートアカウントに `roles/run.invoker`・`roles/eventarc.eventReceiver`。どれも Google の内部アカウントで、外から呼べるようにはしていない
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
- [x] 会社ページ（基本情報と出典、AI のまとめ・営業の切り口・相性のよいサービス・最近の動き、調達・M&A などの履歴、自分のメモと接点・Long List の温度感と進捗、PR TIMES の記事の時系列）と会社の一覧（v0.5）
- [x] 会社 HP の情報（台帳側の共通の HP 読み込み companyWebSweep を prtimes-inbox に作った。読んだ会社は自動で webQueue に依頼、会社ページに「HP から肉付け」ボタン。正式な会社名・所在地・従業員数・資本金・売上高を出どころ付きで表示。会社の AI のまとめの材料にも入れる）（v0.6）
- [x] 見やすさの調整（配色・文字の大きさ・カードの見出し）と、正式な会社名での表示（v0.7）
- [x] HP・Web 検索は指示したときだけに。全部の画面で使える検索窓（× で一度に消す・Esc でも消す）（v0.8）
- [x] 知識のつながり（3D / 2D、似ている会社と理由、押した丸の周りを光らせる・中心に広げる）（v0.9）
- [ ] 全記事と検索（2026-09-01 以降）→ 質問 → レポート → MCP → パートナー

## データの形（自分のコレクション）
- `kbArticles/{記事ID}`：v、id、companyId、source（handoff）、title・company・url・publishedAt、readAt、memo・myTags・stars（Watcher から写す）、draft（Watcher の AI の下書き）、bodyFrom（page / lead）、kb（industry・stage・stageReason・challenges・challengeNote・isCase・caseTitle・caseSummary・facts・talk）、themes（テーマ名の配列）、model、analyzedAt、analysisV、inputHash、state（done / failed）、tries、error
- `kbBodies/{記事ID}`：body（記事ページの本文、最大2万字。取れなければ冒頭）、from（page / lead）、at
- `kbThemes/{テーマ名}`：name、count（入っている記事の数）、service、description、by（ai）、createdAt・updatedAt
- `kbCompanies/{会社ID}`：v、id、name、ai（summary・recent・events[date・type・title・amount・counterpart・articleId]・angles・fits）、model、at、inputHash、articleCount・readCount、state（working / done / failed）、error
- `kbJobs/{自動ID}`：type（company）、id、redo、state（ready / working / done / failed）、at、result、error、by（ingest なら関数から）
- `kbMeta/ingest`：cursor（handoff の updatedAt と記事ID）、lastRunAt、last（回ごとの件数）、total
- `kbMeta/usage_{YYYYMMDD}`：モデルごとのトークン数・requests、usd（見積もり）、by（用途ごとの回数）
- `kbMeta/lock_{name}`：重なって動かないための印
