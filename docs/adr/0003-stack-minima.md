# 0003 — Nada de framework web pesado

**Status:** aceita

## Decisão
O serviço usa apenas os módulos nativos da plataforma e uma biblioteca de WebSocket. Sem framework
web.

## Por quê
Áudio em tempo real é sensível a latência e a memória. Cada camada de framework acrescenta
processamento por mensagem num caminho que passa um bloco de áudio a cada 20 milissegundos.

## Trade-off
Perde-se conveniência (roteamento, middleware, validação prontos). Em troca, o caminho do áudio é
curto e previsível.
