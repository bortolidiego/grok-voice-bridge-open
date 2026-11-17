# grok-voice-bridge

Serviço-ponte Node.js que conecta o áudio do FreeSWITCH à xAI Realtime por WebSocket.

## O que faz

1. Recebe o stream L16/16kHz do FreeSWITCH via `mod_audio_stream`.
2. Exige metadata com `call_uuid` e `bootstrap_token`.
3. Consome o crachá uma vez no voice-broadcast usando autenticação interna.
4. Só após o `consume` 200 abre o WebSocket da xAI.
5. Envia `session.update` com prompt, modelo, voz, velocidade e VAD da campanha; a fala inicial usa o `greeting` do agente.
6. Mantém o transporte PCM 16k→24k, playback ritmado e barge-in correlacionado por `call_uuid`.

## Caminho alternativo: SIP nativo (tronco BYO da xAI)

Quando o discador liga `AI_SIP_NATIVE_ENABLED`, a mídia **não passa por aqui**: o
FreeSWITCH abre uma segunda perna SIP direto para `sip:{numero}@sip.voice.x.ai` e
junta as duas pernas com `uuid_bridge`. Este serviço fica só com o **controle**:

1. O discador chama `POST /internal/sip-precall` (Bearer `VB_INTERNAL_TOKEN`) com
   `correlation_id`, `bootstrap_token` e `call_uuid` — antes do INVITE.
2. O crachá é consumido na hora no voice-broadcast; a configuração de sessão fica
   guardada em memória por até 120s, indexada pelo `correlation_id`.
3. A xAI dispara `realtime.call.incoming`. O `correlation_id` volta no `From` de
   `data.sip_headers` (e no header configurável por `CORRELATION_HEADER`, padrão `X-Correlation-Id`, quando repassado).
4. Achado o pré-registro, abrimos `wss://api.x.ai/v1/realtime?call_id=…` e
   enviamos o `session.update` com o cérebro daquela campanha.

Webhook **sem** pré-registro correspondente é recusado com `409`: atender com um
agente genérico seria pior do que falhar alto.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `XAI_API_KEY` | sim | Chave da API xAI (`Bearer`). |
| `XAI_SIGNING_SECRET` | sim | Secret para validar assinatura dos webhooks. |
| `VB_BASE` | sim (audio stream) | URL interna do sistema discador (`VB_BASE`). |
| `VB_INTERNAL_TOKEN` | sim (audio stream) | Bearer usado exclusivamente em `POST /api/internal/bootstrap-token/consume`. |
| `AUDIO_WS_PORT` | não | Porta WebSocket do `mod_audio_stream` (padrão `8830`). |
| `PORT` | não | Porta HTTP (padrão `8080`). |
| `CORRELATION_HEADER` | não | Nome do header SIP que carrega o `correlation_id` (padrão `x-correlation-id`). |

## Como rodar

### Local

```bash
cp .env.example .env
# edite .env com XAI_API_KEY, VB_BASE e VB_INTERNAL_TOKEN
npm install
npm run start:audio
```

### Docker

```bash
docker build -t grok-voice-bridge .
docker run -p 8830:8830 --env-file .env grok-voice-bridge node src/audio-stream.js
```

## Testes

```bash
npm test
```

## Notas

- Sem framework pesado: usa `node:http` nativo + `ws`.
- Segredos nunca são hardcoded; sempre via variáveis de ambiente.
- O esquema de assinatura do webhook é Svix-compatible e leva um `TODO` para validação contra um webhook real da xAI.
