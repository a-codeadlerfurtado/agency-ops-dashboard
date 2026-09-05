# Cobrança do Imobi-Board via Asaas

Decisão de integração para o modelo por assento (planos Solo, Equipe e
Imobiliária). O backend já está no banco; falta o elo com o provedor.

## Cobrança avulsa mensal, não assinatura de valor fixo

**A escolha é cobrança avulsa gerada todo mês, com cartão tokenizado.**

O motivo é estrutural: o valor só é conhecido no fechamento. Ele depende de
quantos corretores estavam ativos naquele mês, e isso muda entre um vencimento
e outro. Uma `subscription` do Asaas carrega um `value` fixo.

### Por que não a assinatura com `value` atualizado antes do vencimento

Seria preciso dar `PUT` no valor da assinatura antes de o Asaas gerar a
cobrança do ciclo. Essa geração acontece por conta do Asaas, e a janela não é
nossa. Se a atualização chegar depois da geração, a cobrança sai com o valor
antigo — e **cobrar errado é pior que cobrar tarde**: uma cobrança atrasada se
explica, uma cobrança errada tem que ser estornada, e o cliente já viu.

Trocar um problema de agendamento (nosso, controlável) por um problema de
corrida contra a geração do provedor (não controlável) é o pior dos dois lados.

### O risco que a avulsa traz, e por que ele já está coberto

Gerar a cobrança passa a ser responsabilidade nossa: dá para esquecer um mês,
ou cobrar duas vezes. Cobrar duas vezes é o grave — e é impossível aqui:

```sql
constraint faturas_uma_por_competencia unique (tenant_id, competencia)
```

Uma reexecução do fechamento devolve `ja_existia` e não gera nada. Esquecer um
mês é visível: a varredura diária encontra a assinatura ativa sem fatura da
competência corrente.

### Cartão automático continua automático

Cobrança avulsa com `creditCardToken` é cobrada sozinha — o objeto
`subscription` não é requisito para débito automático. O cartão é tokenizado
uma vez, na contratação, e reutilizado a cada competência.

## O fluxo mensal

1. **Dia do vencimento**, `fechar_competencia(tenant)` apura os corretores
   ativos e grava a fatura com o detalhamento em `payload.detalhamento`.
2. A integração cria a cobrança no Asaas com `creditCardToken` e o valor
   apurado, e grava `provedor_payment_id` e `link_pagamento` na fatura.
3. O **webhook** do Asaas recebe `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED` /
   `PAYMENT_OVERDUE` / `PAYMENT_REFUNDED`, atualiza a fatura e chama
   `imobi_board_priv.recalcular_assinatura(tenant)`.
4. A **varredura diária** (`pg_cron`, 06:00 de Brasília) recalcula todas as
   assinaturas. Ela existe porque o evento que não chega é justamente o do
   pagamento que não aconteceu — sem ela, quem nunca paga nunca é bloqueado.
5. Cinco dias de atraso e a assinatura vai a `BLOQUEADA`; os helpers de RLS
   passam a devolver vazio e o CRM inteiro fecha, menos a tela de cobrança.

## O que falta para ligar

| Peça | Estado |
|---|---|
| Tabelas, cálculo por assento, bloqueio, varredura | prontos |
| `provedor_customer_id` / `provedor_subscription_id` / `provedor_payment_id` | colunas existem, nulas |
| Criação do customer no Asaas (por CNPJ/CPF) | falta |
| Tokenização do cartão na contratação | falta |
| Rota de webhook e validação da assinatura do evento | falta |
| Agendamento do fechamento mensal | **falta, e é deliberado** |

O fechamento mensal **não foi agendado de propósito**. Gerar faturas antes de
existir caminho de pagamento criaria dívidas impagáveis, e cinco dias depois a
varredura bloquearia clientes que não tinham como pagar. O agendamento entra
junto com a integração, não antes.

## Uma decisão de contagem que vale confirmar

O assento conta `memberships` ativos com papel `BROKER`. **O administrador não
consome assento** — numa imobiliária pequena ele é o dono, não um atendente a
mais, e cobrá-lo faria o Solo custar assento antes de existir qualquer
corretor. Se a intenção for cobrar por usuário e não por corretor, é uma linha
em `calcular_mensalidade`.
