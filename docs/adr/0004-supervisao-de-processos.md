# 0004 — Dois processos supervisionados, reiniciados sozinhos

**Status:** aceita

## Decisão
O container sobe um supervisor que mantém dois processos vivos — a API de controle e o servidor de
áudio — reiniciando o que morrer.

## Por quê
Separar isola falha: um erro no plano de controle não interrompe o áudio de ligações em curso. E
como se trata de telefonia, ficar de pé por conta própria vale mais que morrer limpo.
