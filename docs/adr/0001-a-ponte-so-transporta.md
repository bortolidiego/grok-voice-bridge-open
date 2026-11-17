# 0001 — A ponte transporta e controla; ela não sabe de negócio

**Status:** aceita

## Decisão
Este serviço cuida do transporte de áudio e do plano de controle da ligação. Campanha, contato,
carteira, recarga, cobrança e relatório pertencem ao discador.

## Por quê
São dois ritmos diferentes: a ponte lida com milissegundos de áudio; o discador lida com regra
comercial que muda toda semana. Misturar faz mudança de regra de negócio exigir mexer no caminho
do áudio — que é onde uma falha derruba ligação em curso.

## Como saber que está sendo violada
Se aparecer aqui um conceito de negócio (preço, saldo, lista de contatos), a fronteira furou.
