# Armadilhas conhecidas — o que já quebrou aqui

## 1. Ligação presa depois de o cliente desligar
**O que houve (2026-07-15):** quando o destinatário desligava o aparelho, a perna do lado da
central às vezes não era encerrada — o aviso de desligamento não chegava. A ligação ficava presa
até o tempo limite de 15 minutos do outro lado, **contando como ligação ativa esse tempo todo**.
**Prevenção:** passar o identificador da chamada nos metadados do início do áudio, para haver como
rastrear e encerrar ativamente.

## 2. Interrupção por fala falhando com "operação falhou"
**O que houve (2026-07-15):** o comando de corte era enviado antes de a central confirmar que
começou a tocar áudio, e falhava.
**Prevenção:** o corte só dispara depois da primeira confirmação de reprodução.

## 3. O cliente ouvia a saudação duas vezes
**O que houve:** quando a linha já tinha tocado a saudação pré-gravada, a IA repetia a abertura.
**Prevenção:** avisar a IA de que a saudação já foi dada, e ignorar o microfone enquanto o áudio
inicial toca.

## 4. SIP sem cifrar cai em 2 segundos
Tentativas por UDP puro sofrem perda de pacote e desconexão prematura. O caminho oficial exige
transporte cifrado. Ver `docs/adr/0007-transporte-sip-exige-tls.md`.

## 5. O container não alcança as portas de controle da central
**Sintoma:** conexão recusada ao tentar falar com a central telefônica.
**Causa:** as portas de controle não são alcançáveis da rede do container sem túnel ou rede
compartilhada configurada.
**Consequência:** a ponte segue funcionando, sem interrupção por fala (ver ADR 0006) — o defeito
aparece como qualidade de conversa, não como erro.
