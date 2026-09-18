# 開発エージェントへの入口

実装前にREADMEと必要な設計・受入条件を確認し、対象Issueの範囲を明確にする。

## ブランチとPR

- `dev`を通常作業の起点にする。`dev`と`main`へ直接pushせず、Issue用ブランチからDraft PRを作ってPR経由で集約する。
- GitHubのdefault branchが`main`でも、実装の起点は`dev`。自動化ワークフローはdefault branch上のコードを使うため、ワークフロー変更はmainにもPRで反映する。
- CI成功、実装済み、実機・利用者受入済みは別々に確認する。

## Issue／PRの着手状態

- 実装前にIssueへ`/start`だけのコメントを投稿する。`agent:start`はActionsが付ける内部マーカーなので手動で付けない。
- Actionsが最新`dev`から空コミット付きブランチとDraft PRを作る。Draft PR作成を確認してから、そのブランチ・PRを再利用して実装する。
- Issue作成→Todo、関連open PRあり（Draftを含む）→In Progress、現在のCI失敗・変更要求・PRを閉じたままの未完了Issue→Needs attention、Issue closed→Done。ProjectはIssue/PRから自動算出される表示で、手動更新しない。

## 完了と部分実装

- PR本文に独立した行で`Refs #<番号>`を残す。受入条件をすべて満たす場合だけ`Closes #<番号>`（`Fixes`／`Resolves`も可）へ変更する。
- 部分実装なら、マージ前に残件を新しいIssueへ切り出し、その本文に独立した行で`Parent: #<元Issue番号>`を記載する。残件Issueなしに部分PRだけで元Issueを完了扱いにしない。
- 詳細な状態遷移、障害復旧、Project設定は`docs/PROJECT_AUTOMATION.md`と`docs/ISSUE_WORKFLOW.md`を参照する。

<!-- MAC-ENABLER:BEGIN -->
## Shared Codex workflow

このブロックは `kdob1042/mac-enabler` から生成された共通運用部分です。直接編集せず、mac-enablerを更新して同期します。

- 作業開始時に、タスクを `triage`・`implementation`・`architecture`・`review`・`verification`・`documentation`・`incident`・`handoff` のいずれかへ分類し、`.codex/mac-enabler/model-routing.json` のプロファイルを確認する。
- ルートとプロファイルを決めてから実装へ進む。利用ホストがモデルを切り替えられない場合は、選択したプロファイルを報告し、切り替わったと偽らない。
- プロジェクト固有の設計、ブランチ、テスト、データの正本は、このリポジトリの既存 `AGENTS.md` と設計書に従う。共通ブロックはそれらを上書きしない。
- Issue／PRを使う場合、作業状態・検証結果・残件の正本はIssue／PRへ残す。
- `compact`／自動コンパクションの前に、目標、制約、ルート、プロファイル、ブランチ／PR、変更ファイル、テスト結果、残作業、未解決事項、次の一手を引き継ぎパケットとして保存する。
- コンパクション後または別エージェントへ渡された後は、対象リポジトリの `AGENTS.md` と最新の引き継ぎパケットを読み、記録された次の一手から再開する。
- 共通ルールとプロジェクトルールが衝突した場合、プロジェクト固有の事実・受入条件を優先する。解決できない場合は推測で進めず、衝突を報告する。

<!-- MAC-ENABLER:END -->
