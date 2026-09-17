# Project自動同期

このテンプレートは、Issueを正本としてDraft PRとProjectの表示を同期する。通常の開始操作はIssueコメントの`/start`だけで、ラベルとProjectを人手で二重管理しない。

## 状態遷移

| Issue/PRの実態 | Project Status |
| --- | --- |
| open Issue、関連PRなし | Todo |
| 同一リポジトリの関連open PRあり（Draftを含む） | In Progress |
| 現在のPR先端の指定CI失敗・キャンセル・変更要求 | Needs attention |
| 着手マーカーはあるが関連PRがない、またはPRを閉じたまま未完了 | Needs attention |
| Issue closed | Done |

Projectは一方向の表示であり、ProjectをDoneにしてもIssueは閉じない。Issueを閉じるのは、対象ブランチ（通常は`dev`または`main`）へマージされたPRが明示的な完了参照を持つ場合だけである。

## 通常フロー

1. Issueを作る。`Sync project status`がカードを追加してTodoにする。
2. エージェントがIssueへ独立した`/start`コメントを投稿する。Actionsが内部ラベル`agent:start`を付け、`dev`から`issue/<番号>-work-<連番>`を作り、空コミット付きDraft PRを作成する。
3. 作成されたDraft PRとブランチを再利用して実装する。PR本文の`Refs #<番号>`は実装中のまま残す。
4. 受入条件をすべて満たしたときだけ、PR本文の独立行を`Closes #<番号>`（`Fixes`／`Resolves`も可）へ変更し、検証後にReady for reviewにする。
5. PRが`dev`または`main`へマージされると、同期処理がIssueを閉じ、同じ実行でProjectをDoneにする。

PRが部分実装の場合は、先に残件Issueを作り、その本文に独立した`Parent: #<元Issue番号>`を記載する。元PRは`Refs`のままマージし、同期が元Issueを閉じ、残件IssueをTodoにする。残件Issueなしの部分PRでは元Issueを閉じない。

## 設定

| 種別 | 名前 | 既定値 | 用途 |
| --- | --- | --- | --- |
| Repository secret | `PROJECTS_TOKEN` | なし | Issue/PR/Contents/Actionsの読取り・書込みと、ユーザーProjectの書込み権限を持つトークン |
| Repository variable | `PROJECT_OWNER` | `github.repository_owner` | Project所有者のログイン名 |
| Repository variable | `PROJECT_NUMBER` | `1` | 対象Project番号 |
| Repository variable | `WORK_BRANCH` | `dev` | Draft PRの起点・通常のマージ先 |
| Repository variable | `PROJECT_SYNC_CI_NAME` | 空 | `Needs attention`判定に使うCI workflowの表示名。空ならCI結果は判定せず、レビュー状態だけを見る |
| Repository variable | `AUTOMATION_ACTIVATED_AFTER` | リポジトリ作成時刻 | 導入前の過去PRでIssueを遡及クローズしないためのUTC時刻。導入時刻を明示することを推奨 |

ProjectのStatusには`Todo`、`In Progress`、`Needs attention`、`Done`を用意する。Project側のAuto-close Issue（Done→Issue closed）は無効にする。カードの手動Statusは次の同期で実態に戻る。

`Start issue with draft PR`と`Sync project status`はdefault branch上のワークフローとスクリプトを使う。`dev`に追加しただけでは有効化されないため、ワークフロー変更は必ずmainへPRで反映する。

## CI連携

`project-status.yml`は`Automation checks`、`CI`、`Start issue with draft PR`の完了を同期イベントとして監視する。別名のCIを使う場合は、`PROJECT_SYNC_CI_NAME`に正確なworkflow名を設定し、`project-status.yml`の`workflow_run.workflows`にもその名前を一度だけ追加する。設定しない場合も、Issue/PRイベントと毎時同期でProject表示は更新される。

## 障害復旧

- `PROJECTS_TOKEN`がない・権限不足・Status選択肢不足の場合、Actionsは失敗して状態を成功扱いにしない。
- `Sync project status`をworkflow_dispatchで`dry_run=true`にして差分を確認し、問題なければ`false`で反映する。
- `/start`の実行に失敗した場合は、権限とSecretを直して`/start`を再投稿する。workflow_dispatchは管理者の緊急復旧専用である。
- 過去イベントの順序ではなく、毎回Issue・PR・レビュー・CIの現在状態を再取得する。アーカイブ済みカードは復元・重複追加しない。

テスト: `node --test .github/scripts/project-sync.test.cjs`。
