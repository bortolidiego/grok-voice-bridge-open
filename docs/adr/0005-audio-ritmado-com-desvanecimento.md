# 0005 — Áudio sai em blocos ritmados, com desvanecimento ao cortar

**Status:** aceita

## Decisão
O áudio da IA é entregue à telefonia em blocos de duração fixa. Quando é interrompido, o corte tem
um desvanecimento curto. Quando não há áudio, envia-se silêncio.

## Por quê
Telefonia não perdoa: corte seco vira estalo no ouvido do cliente, e buffer vazio vira ruído.
Ritmar e desvanecer é o que faz soar como uma ligação normal.
