# 0006 — Se o canal de controle cair, o áudio continua

**Status:** aceita

## Decisão
A conexão de controle com a central telefônica opera de forma tolerante: se ficar indisponível ou
reiniciar, o áudio segue fluindo.

## Por quê
Perder o controle degrada a experiência (a interrupção por fala para de funcionar). Derrubar a
ligação por causa disso destrói a experiência. Entre degradar e derrubar, degrada.

## Note a diferença para a ADR 0002
Ali, falhar **fechado**; aqui, falhar **aberto**. Não é incoerência: antes de a ligação começar, o
risco é cobrar por atendimento indevido; com a ligação em curso, o cliente já está na linha.
