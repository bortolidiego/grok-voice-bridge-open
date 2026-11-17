# CONTEXT — Glossário do domínio (grok-voice-bridge)

> Glossário e nada mais: o que cada termo significa **neste** sistema.
> Decisões que não devem ser refeitas: `docs/adr/`. O que já quebrou: `docs/agents/armadilhas.md`.

---

**Ponte de voz**
Este serviço. Ele liga a telefonia à IA de voz e cuida do trânsito entre as duas — e **só disso**.
Campanha, contato, carteira, recarga e cobrança pertencem ao discador, não a ele.
_Avoid_: Bridge, gateway, discador

**Discador**
O sistema que decide para quem ligar, quando ligar e quanto isso custa. É quem chama a ponte, não
o contrário.
_Avoid_: Broadcast, campanha (campanha é o que ele executa, não o que ele é)

**Perna**
Cada lado de uma ligação: a perna do cliente e a perna da IA. Falar em "perna" evita a ambiguidade
de "chamada", que às vezes é uma e às vezes as duas.
_Avoid_: Canal, chamada (quando se quer dizer um lado só)

**Crachá de sessão**
Autorização de uso único e curta duração que o discador emite para cada ligação. Sem crachá
válido, a ponte recusa antes de abrir qualquer canal com a IA — porque abrir canal já custa
dinheiro (ver `docs/adr/0002-sem-cracha-nao-atende.md`).
_Avoid_: Token, bootstrap token, chave

**Identificador de correlação**
O número que amarra uma ligação entrante à campanha que a originou. Sem ele, a ponte não sabe de
quem é a ligação.
_Avoid_: ID, correlation id, tag

**Interrupção por fala**
Quando o cliente começa a falar por cima da IA e o áudio dela é cortado na hora. É o que separa
uma conversa de uma gravação.
_Avoid_: Barge-in, corte

**Saudação pré-gravada**
Uma abertura tocada na linha telefônica antes de a IA assumir. Quando ela toca, a IA é instruída a
**não** repetir a abertura — senão o cliente ouve a mesma coisa duas vezes.
_Avoid_: Áudio inicial, intro

**Cérebro**
As instruções e o conhecimento que definem como a assistente de voz fala e o que ela pode
prometer. Cada produto tem o seu.
_Avoid_: Prompt, persona, contexto
