# ADR 0005：Rule-based adviceをbaselineとする

- Status：Accepted
- Date：2026-07-21

## Context

不足した実験条件，figure，data，comparison，metric，citationを外部LLMなしでも検出し，結果を再現可能にする必要がある．LLMだけではnetwork，cost，non-determinism，hallucinationがtestと研究用途に不向きである．

## Decision

Typed PaperSpec，section，asset，referenceを検査するpure ruleをregistryへ登録する．Adviceはstable ID，category，severity，reason，evidence，action，targetを持つ．Template固有ruleはtagで追加し，LLM adviceは別originとして任意に併用する．

## Consequences

- Offlineで安定して動作し，positive／negative testを書ける
- 検出理由が利用者へ説明可能になる
- Semantic nuanceには限界があり，誤検出は解決済みとして管理する必要がある
- Keywordだけの断定を避け，複数signalとstructured fieldを利用する

## Alternatives

LLM-only adviceは柔軟だが，未設定時にcore価値が失われる．Hard-coded checkをrouteへ散在させる方式は拡張とtestが困難なため採用しない．
