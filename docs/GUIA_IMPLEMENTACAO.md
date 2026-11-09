> **Actualização v0.2:** Este documento descreve principalmente a arquitectura-base v0.1. O portal regional autenticado, a recepção e os novos endpoints estão documentados em `NOVIDADES_V02.md`, `COMANDOS_OPERACAO.md` e no README principal.

# Guia de implementação — tarefas para a equipa SCAD

**Método de estudo:** trabalhar por tickets, validar critérios de aceitação e registar evidência. O código inicial está preparado, mas cada membro deve compreender as transacções, a replicação e a recuperação. Não entregar uma arquitectura apenas porque os containers arrancam.

## Ticket 01 — Executar ambiente e verificar as 3 regiões

**Objectivo:** provar que Maputo, Beira e Nampula possuem instâncias primárias independentes.

**Passos:**
1. Instalar Docker + Compose v2 e confirmar `docker compose version`.
2. Criar `.env` e correr `docker compose up --build -d`.
3. Executar `docker compose ps`; confirmar 15 serviços (9 de infraestrutura, 3 aplicações e 3 agentes regionais).
4. Verificar `GET /api/stocks` e executar SQL em `pg-south`, `pg-center`, `pg-north`.
5. Explicar por que três tabelas na mesma BD não equivalem a três nós distribuídos.

**Aceitação:** cada primário mostra apenas stocks da sua região; a API agrega exactamente os seis registos iniciais. **Evidência:** outputs `docker compose ps`, `SELECT region,... FROM stock_positions`, screenshot do dashboard.

## Ticket 02 — Validar e explicar a replicação física

**Objectivo:** demonstrar que as alterações no primário chegam ao standby por WAL.

**Passos:**
1. Executar `./scripts/check-replication.sh`.
2. Consultar `pg_stat_replication` e `pg_is_in_recovery()`.
3. Actualizar stock através da API.
4. Consultar o mesmo produto no standby após o replay.
5. Parar o standby, actualizar o primário, reactivar o standby e verificar que recupera as alterações retidas em WAL.

**Aceitação:** streaming está activo nas três regiões e cada standby recebe os valores actualizados. **Não** aceitar como evidência de failover a simples leitura na réplica.

## Ticket 03 — Exclusão mútua e idempotência

**Objectivo:** impedir duas ordens conflitantes para o mesmo lote/fornecedor.

**Passos:**
1. Ler `src/coordination.ts` e explicar o funcionamento do lease etcd.
2. Ler a constraint `UNIQUE(supplier_id,batch_id)` em PostgreSQL Norte.
3. Enviar 10 pedidos concorrentes com a mesma chave de lote.
4. Consultar o catálogo e contar ordens para o batch.
5. Simular timeout do cliente após envio e reenviar com a mesma chave.

**Aceitação:** no máximo uma ordem persistida por lote/fornecedor e sem duplicação do stock pendente. **Pergunta de defesa:** o que acontece se o processo ficar suspenso por mais tempo do que o TTL do lock?

## Ticket 04 — Two-Phase Commit entre shards

**Objectivo:** demonstrar atomicidade da criação de ordens com reposição em várias regiões.

**Passos:**
1. Ler `src/twoPhase.ts`, `pg_prepared_xacts` e o registo em etcd.
2. Criar ordem envolvendo Sul e Centro.
3. Verificar que ambos receberam `incoming_qty` e que há exactamente uma ordem Norte.
4. Introduzir testes de falha nos pontos: antes de PREPARE, após um PREPARE, após decisão COMMIT e durante o COMMIT.
5. Verificar o algoritmo de recuperação ao reiniciar o coordenador.

**Aceitação:** não surge compra visível parcialmente concluída nos fragmentos depois de recovery; uma decisão COMMIT gravada nunca é substituída por ABORT. **Nota:** os testes injectados de falhas ainda precisam de ser escritos; o script base testa prepared xacts em condições normais.

## Ticket 05 — Fornecedores REST e SOAP

**Objectivo:** demonstrar interoperabilidade e retries seguros.

**Passos:**
1. Consultar `apps/supplier-mock/src/supplier.wsdl`.
2. Verificar a diferença entre JSON e o envelope SOAP.
3. Confirmar uma compra do produto `RICE25` (REST) e `OIL1L` (SOAP).
4. Simular HTTP 503 e SOAP Fault e observar o estado `PENDING_SUPPLIER`.
5. Mostrar que uma retransmissão conserva o mesmo `externalOrderId`.

**Aceitação:** os dois protocolos funcionam; 503 não perde ordens; chamadas repetidas não criam compras externas duplicadas.

## Ticket 06 — Auditoria, PDFs e recuperação de ficheiros

**Objectivo:** demonstrar persistência local dos documentos e planear DFS real.

**Passos:**
1. Consultar `GET /api/audit`.
2. Abrir PDF de uma compra confirmada.
3. Inspeccionar o volume Docker `scad_files`.
4. Reiniciar o container da API e validar os ficheiros.
5. Comparar volume Docker com GlusterFS replicado; anotar que só o segundo satisfará a exigência DFS.

**Aceitação MVP:** documentos sobrevivem ao reinício do container; **não** alegar tolerância à queda do host.

## Ticket 07 — Evolução obrigatória após MVP

**Objectivo:** cobrir componentes do enunciado ainda em falta.

**Backlog priorizado:**
1. GlusterFS replicado em três VMs, com montagem transparente e teste de perda de nó.
2. Chrony/NTP em cada VM com medições e screenshots de sincronização.
3. Fencing tokens e prova contra locks antigos.
4. Failover PostgreSQL com promoção controlada e reconexão da aplicação.
5. Recuperação idempotente de PDFs e reconciliação do estado do fornecedor.
6. Agentes regionais como processos separados.
7. Métricas, tracing e relatórios da defesa.

## Critérios de revisão do projecto

| Critério | Peso sugerido |
|---|---:|
| Fragmentação e replicação correctamente demonstradas | 20% |
| Exclusão mútua e controlo de duplicação | 20% |
| 2PC e recuperação perante falhas | 25% |
| Integração REST/SOAP e idempotência | 15% |
| DFS, relógios e resiliência de nós | 10% |
| Código, testes e apresentação | 10% |

Estes pesos são **rubrica de acompanhamento interno**, não a grelha oficial de avaliação do docente. A grelha original vale 200 pontos e contempla Java/CORBA, a substituir apenas mediante autorização.
