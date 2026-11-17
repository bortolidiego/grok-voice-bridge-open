# 0007 — O transporte SIP com a IA é obrigatoriamente cifrado

**Status:** aceita

## Decisão
As chamadas pelo caminho SIP nativo usam exclusivamente transporte cifrado (TLS/SRTP).

## Por quê
Não é só segurança: nas tentativas com UDP puro, as ligações caíam em cerca de 2 segundos, com
perda de pacote e desconexão. O transporte cifrado é o único caminho suportado do outro lado.
