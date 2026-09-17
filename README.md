# Development template

Issue-driven development template:

- Issueへの`/start`コメントを着手操作に統一
- `dev`起点の空コミット付きDraft PRを自動作成
- Issue・PR・CI・レビューからProject Statusを自動同期
- 部分実装は`Parent: #<番号>`の残件Issueへ移管

## 初回設定

1. `dev`ブランチを通常作業の起点にする。
2. Repository secret `PROJECTS_TOKEN`を登録する。
3. `PROJECT_OWNER`、`PROJECT_NUMBER`、必要なら`PROJECT_SYNC_CI_NAME`をRepository variablesに登録する。
4. ProjectのStatusに`Todo`、`In Progress`、`Needs attention`、`Done`を用意する。
5. 詳細は`docs/PROJECT_AUTOMATION.md`を読む。

自動化のロジックテストは次で実行する。

```sh
node --test .github/scripts/project-sync.test.cjs
```
