# Teste sintético real do módulo FreeSWITCH — sem PSTN

**Status:** aprovado em 2026-07-15 nos modos fake e módulo real.
**Fake:** aprovado localmente com playback e barge-in separados.
**Módulo real:** quatro cenários aprovados na central, com `mod_audio_stream` real, ESL e WAVs gravados.
**Porta:** alternativa `8831` em `127.0.0.1` (não conflita com produção na 8830).  
**Nenhuma chamada telefônica real ou gateway externo é usada.**

## Objetivo

Validar ponta a ponta o transporte `mod_audio_stream ↔ grok-voice-bridge ↔ fake xAI` sem depender de telefonia real. O fake xAI é determinístico: envia um tom PCM 24k conhecido e responde a `input_audio_buffer.append` com eventos pré-programados.

## Arquitetura do harness

```
FreeSWITCH local/loopback
  → mod_audio_stream conecta em ws://127.0.0.1:8831
  → grok-voice-bridge audio-stream-server (porta 8831)
  → fake xAI WebSocket (injetado via createXaiSocket)
```

O harness inicia:
1. Servidor WebSocket em `127.0.0.1:8831` (`createAudioStreamServer` com `host: 127.0.0.1` e `port: 8831`).
2. Fake xAI que:
   - responde a `session.update` com `session.updated`;
   - envia deltas PCM 24k de tons senoidais conhecidos (base64);
   - após receber M frames de input, dispara `input_audio_buffer.speech_started`.
3. Fake do endpoint `/bootstrap-token/consume`, stateful e sem rede, que aceita cada token uma vez e devolve agente/config sintéticos completos.
4. Cliente mod_audio_stream fake OU FreeSWITCH real com originate inline canônico que:
   - envia metadata JSON `{ call_uuid: "test-uuid", bootstrap_token: "synthetic..." }`;
   - envia PCM 16k mono (silêncio ou tom) por T segundos;
   - recebe `streamAudio` e decodifica para arquivo PCM/WAV.

## Como rodar

```bash
# 1. Pré-condição: instalar FreeSWITCH com mod_audio_stream.
#    Em macOS: não há pacote oficial; compilar do source ou usar Docker.
#    Em Linux Debian/Ubuntu:
#      apt-get install freeswitch-mod-audio-stream  # se disponível
#    Ou compilar:
#      git clone https://github.com/freeswitch/freeswitch
#      cd freeswitch
#      ./configure --enable-core-pgsql-support --prefix=/usr/local/freeswitch
#      make mod_audio_stream-install

# 2. Iniciar FreeSWITCH.
#    freeswitch -ncwait

# 3. Rodar o harness fake/local.
MODE=fake node test/synthetic-mod-audio-stream.mjs

# 4. Rodar o harness real (somente no host FreeSWITCH/ESL, sem alterar dialplan/config).
#    STREAM_PLAYBACK=true MODE=real ESL_PASSWORD=... node test/synthetic-mod-audio-stream.mjs
```

## Observação de execução

- `MODE=fake` e `MODE=real` exigem bind local em `127.0.0.1:8831`.
- Em ambientes com sandbox que bloqueiam `listen(2)`, a CLI deve ser executada externamente com permissão; isso não invalida os testes puros da suíte.
- `npm test` cobre parser ESL, framing, allowlist, métricas puras e helpers. O teste CLI com `child_process` fica opt-in via `RUN_BIND_CLI_TESTS=1`.
- `MODE=real` não aceita comando arbitrário de originate. O script gera internamente apenas:
  `originate {origination_uuid=<uuid>,loopback_bowout=false,STREAM_PLAYBACK=true}loopback/set:synthetic_test=true\,answer\,park/default/inline &echo()`
- `STREAM_PLAYBACK=true` precisa estar na variável do canal sintético. Sem ela, o
  módulo aceita o arquivo e emite `play`, mas não consome a fila nem emite
  `chunk_played`.
- O `uuid_audio_stream start` é montado pelo mesmo helper testado pelo bridge e
  inclui a metadata de correlação e autenticação sem espaços:
  `uuid_audio_stream <uuid> start ws://127.0.0.1:8831 mono 16k {"call_uuid":"<uuid>","bootstrap_token":"synthetic..."}`

## Critérios objetivos de aprovação

| # | Critério | Como medir |
|---|---|---|
| 1 | Fake aprovado | fake xAI envia N deltas; bridge encaminha N `streamAudio`; barge-in e playback são validados em cenários separados |
| 2 | Real seguro | `MODE=real` usa ESL auth, `event plain`, filtros reais, originate loopback inline canônico, `uuid_record`, `uuid_audio_stream start/stop` via API síncrona e cleanup best-effort |
| 3 | WAV não-silencioso | cada WAV tem energia acima do limiar e frequência compatível com 440, 550, 660 ou 880 Hz |
| 4 | Duração ativa | região não silenciosa do WAV fica dentro de tolerância realista |
| 5 | Eventos | `connect`, `play`, `playback`, `chunk_played` e `queue_completed` são observáveis; o fechamento também é confirmado pelo WebSocket e pelos contadores finais |
| 6 | Sem gateway externo | nenhuma conexão SIP/RTP para fora; bridge só fala com 127.0.0.1:8831 e fake xAI |

## Fallback sem FreeSWITCH real

Se FreeSWITCH não estiver disponível, o harness pode ser executado com um **cliente mod_audio_stream fake** que simula o protocolo binário/texto do módulo. Isso NÃO é aprovação da integração real, mas valida a lógica do bridge. O arquivo `test/synthetic-mod-audio-stream.mjs` contém ambos os modos:
- `MODE=fake` (default, roda sem FreeSWITCH)
- `MODE=real` (exige FreeSWITCH com `mod_audio_stream` e ESL, mas sem alterar dialplan nem config persistente)
