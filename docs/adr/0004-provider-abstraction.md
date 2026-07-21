# ADR 0004：文章生成providerを抽象化する

- Status：Accepted
- Date：2026-07-21

## Context

外部LLMを必須にせず，rule-based，local Ollama，OpenAI互換API，test mockを同じgeneration pipelineで扱う必要がある．Provider固有HTTP処理がrouteやtemplateへ漏れると，privacy判断とtestが困難になる．

## Decision

Typed `GenerationRequest`／`GenerationResponse` を受け渡すasync Protocolを定義し，factory／registryでproviderを選択する．ProviderはDB，filesystem，web responseへaccessしない．Timeout，schema validation，secret masking，fallbackはservice層とprovider adapterの責務を明確に分ける．

## Consequences

- External serviceなしのtestとprovider差替えが容易になる
- UIは共通availabilityとprivacy noticeを表示できる
- Provider能力差を最小共通contractへ写像する必要がある
- LLM responseが正しい事実であるとは扱わず，post-generation adviceを必ず実行する

## Alternatives

Specific SDKの直接callは初期実装が短いが，vendor lock-in，secret leakage，mock困難を招くため採用しない．
