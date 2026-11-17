# 0002 — Ligação sem autorização prévia é encerrada, não atendida

**Status:** aceita

## Decisão
Se chega uma ligação sem o registro prévio correspondente, a ponte **encerra na hora**. Ela não
assume um atendimento genérico.

## Por quê
Atender com instruções genéricas parece a opção gentil e é a pior das duas: gera cobrança pelo uso
da IA por uma ligação que ninguém pediu, e entrega ao cliente um atendimento que não tem nada a
ver com o motivo do contato. Falhar fechado é a escolha certa aqui.

## Trade-off
Uma falha no registro prévio derruba ligações legítimas. Aceito, porque o modo de falha é visível
(a ligação cai) em vez de silencioso (cobrança e atendimento errado).
