> **Actualização v0.2:** Este documento descreve principalmente a arquitectura-base v0.1. O portal regional autenticado, a recepção e os novos endpoints estão documentados em `NOVIDADES_V02.md`, `COMANDOS_OPERACAO.md` e no README principal.

# Roteiro de demonstração — SCAD Coordena MVP

## Preparação

Usar dados de laboratório; guardar screenshots e outputs no relatório. Preferir ambiente limpo para reproduzir os exemplos:

```bash
# DESTRUTIVO: apaga volumes existentes. Fazer apenas se for seguro perder os dados.
docker compose down -v
docker compose up --build -d
docker compose ps
```

Abrir `http://localhost:8080` e `http://localhost:3000/api/cluster`.

## Cenário A — Compra automática consolidada

1. Consultar `GET /api/stocks`. Os stocks de arroz Sul=3, Centro=4 e Norte=12 já vêm carregados.
2. Clicar **Verificar stock e comprar** ou executar `curl -X POST localhost:3000/api/monitor/run`.
3. Consultar `GET /api/purchases`: o arroz envolve Sul+Centro e pede 33 unidades; o óleo envolve Centro+Norte e utiliza SOAP.
4. Esperar uma ronda do dispatcher (configuração inicial: 20 segundos) e verificar `CONFIRMED`.
5. Abrir o PDF da ordem e ver a auditoria.

**Resultado:** a ordem é consolidada, o stock físico não aumenta imediatamente, mas `incoming_qty` aumenta.

## Cenário B — Concorrência

```bash
./scripts/test-e2e.sh
```

O script dispara 10 pedidos simultâneos para a mesma chave e verifica a unicidade da ordem em `purchase_orders`. O teste pode devolver erros de lock/timeout em alguns pedidos: isto não constitui duplicação; confirmar a invariável do estado persistido.

## Cenário C — Replicação

```bash
./scripts/check-replication.sh
```

Actualize um valor em Sul:

```bash
curl -X POST localhost:3000/api/stocks/south/RICE25/adjust \
  -H 'Content-Type: application/json' -d '{"onHand":7}'
docker compose exec pg-south-replica psql -U scad -d scad \
  -c "SELECT region, product_id, on_hand FROM stock_positions WHERE product_id='RICE25';"
```

Se a alteração ainda não chegou, aguardar alguns segundos devido à replicação assíncrona. Mostrar `pg_is_in_recovery()` para provar que o nó consultado é o standby.

## Cenário D — Queda e recuperação de standby

```bash
docker compose stop pg-south-replica
# Actualizar stock em Sul através da API.
docker compose start pg-south-replica
./scripts/check-replication.sh
```

Este teste demonstra recuperação de **réplica**, não failover do primário.

## Cenário E — Falha do fornecedor

O fornecedor expõe uma API administrativa na rede interna Docker para simulação. Activar indisponibilidade:

```bash
docker compose exec -T api node -e '
fetch("http://supplier-mock:4000/admin/failure-mode", {
 method:"POST", headers:{"content-type":"application/json"},
 body: JSON.stringify({mode:"unavailable"})
}).then(x=>x.text()).then(console.log)'
```

Criar nova ordem com um `batchId` único através de `POST /api/purchases`. Após uma ronda do dispatcher, observar `PENDING_SUPPLIER`, `retry_count` e `last_error`. Repor o fornecedor:

```bash
docker compose exec -T api node -e '
fetch("http://supplier-mock:4000/admin/failure-mode", {
 method:"POST", headers:{"content-type":"application/json"},
 body: JSON.stringify({mode:"off"})
}).then(x=>x.text()).then(console.log)'
```

Depois do backoff, a ordem deverá passar a `CONFIRMED`.

## Cenário F — Recuperação 2PC (segunda iteração)

A v0.1 **possui código de recovery** mas não contém ainda scripts determinísticos de injecção de falhas em cada fase. É um exercício obrigatório antes da defesa final: acrescentar flags de laboratório controladas (`CRASH_AFTER_PREPARE`, `CRASH_AFTER_DECISION`) e testes que comprovem recuperação após reinício da API. Não apresentar estes testes como já realizados.

## Cenário G — Perda de quórum etcd

Parar dois membros:

```bash
docker compose stop etcd2 etcd3
```

A ausência de quórum deve impedir novas decisões de exclusão mútua e registos 2PC. Repor:

```bash
docker compose start etcd2 etcd3
```

**Atenção:** a resposta da API pode demorar devido a timeouts de reconexão. Este teste não demonstra disponibilidade durante a partição: demonstra que o sistema prefere não decidir sem coordenação fiável.

## Limites a reconhecer na defesa

- Sem GlusterFS, um volume Docker não é um DFS resistente à perda do host.
- Replicação física não significa failover automático.
- NTP não foi configurado em hosts independentes.
- A componente original Java/CORBA está substituída por decisão de projecto, pendente de validação do docente.
- Um conjunto de containers no mesmo host não assegura alta disponibilidade física.
- A integração com fornecedores é uma simulação idempotente, não uma operação comercial real.
