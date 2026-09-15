# Imóveis, matching e fechamento

O que acontece depois que o lead foi qualificado.

## Imóvel: uma tabela, não duas

A spec sugeria `properties` + `developments` + `property_units`. Ficaram duas:
`developments` e `properties`. Uma unidade de empreendimento e um usado avulso
têm exatamente as mesmas vinte colunas — preço, área, quartos, vaga, bairro. A
única diferença é `development_id` estar preenchido ou não.

Duas tabelas idênticas significariam duas queries em todo lugar, dois conjuntos
de índices e um matching que precisa fazer `UNION`. Não paga.

```sql
create index properties_busca_idx
  on properties (tenant_id, neighborhood, price)
  where status = 'AVAILABLE';
```

Parcial de propósito: imóvel vendido ou inativo não entra em busca nenhuma, e o
índice fica pequeno mesmo com o estoque crescendo.

**Quem vê o quê:** o estoque é do tenant inteiro — o corretor precisa dele para
vender (spec §12 fala em "imóveis liberados para o tenant"). Cadastrar, editar e
desativar é só do ADMIN.

---

## Matching

Determinístico, barato e explicável. Sem IA — por decisão, não por limitação: o
corretor precisa defender a sugestão na frente do cliente, e "a IA achou" não
defende nada.

### Pesos

| Critério | Peso |
|---|---|
| bairro | 25 |
| faixa de preço | 25 |
| tipo | 15 |
| quartos | 15 |
| metragem | 10 |
| vagas | 10 |

### A regra que faz diferença

**Critério não preenchido não entra na conta.** Não conta a favor nem contra: o
peso sai do denominador. Sem isso, um lead com dois critérios informados nunca
passaria de 50% e o score viraria ruído.

```
score = 100 × pontos obtidos / soma dos pesos informados
```

### Crédito parcial

Dois casos ganham meio ponto, porque a realidade da negociação é essa:

- **Preço até 10% acima do teto** vale 12 de 25. Cliente estica, corretor
  negocia. Um imóvel 5% acima do orçamento não é um não.
- **Área até 10% abaixo do mínimo** vale 5 de 10.
- **Cidade certa, bairro errado** vale 12 de 25.

### Verificado

Interesse: Aquarius, até R$ 1 mi, 3 quartos, 2 vagas, 90 m²+.

| Imóvel | Preço | Área | Q/V | Score |
|---|---|---|---|---|
| Vista Residence 101 | 890 mil | 92 m² | 3/2 | **100%** |
| Vista Residence 202 | 960 mil | 98 m² | 3/2 | **100%** |
| Usado no Aquarius | 720 mil | 84 m² | 3/2 | **95%** |
| Vista Residence 305 | 1,18 mi | 118 m² | 4/3 | **75%** |
| Vista Residence 402 | 845 mil | 86 m² | 2/1 | **70%** |
| Compacto Aquarius | 480 mil | 58 m² | 2/1 | **65%** |
| Jardins Tower 110 | 1,45 mi | 104 m² | 3/2 | **62%** |

O de 95% perde 5 pontos por ter 84 m² contra 90 pedidos. O de 75% zera em preço
por estourar o teto em mais de 10%. O de 62% pega só metade da localização
(cidade certa, bairro errado).

A UI mostra ✓ / ~ / ✕ por critério ao lado do score. Imóvel vendido some da
lista automaticamente.

---

## Visita e proposta

Ambas empurram a oportunidade para a etapa correspondente — mas **nunca para
trás**. Agendar visita num lead que já está em Proposta não o rebaixa.

Proposta guarda `list_price` além do `offered_price`. Se o corretor não digitar
o preço de tabela, ele vem do imóvel. É o que permite mostrar o desconto sem
depender de alguém ter preenchido.

---

## Venda: a regra da §80

**Arrastar o card para "Venda" não fecha negócio.** Tentar isso devolve:

```
Use "Registrar venda" para fechar: a venda precisa de valor.
```

Venda exige valor, e valor exige uma pessoa digitando. Proposta aceita também
não vira venda sozinha — ela sinaliza e para.

`registrar_venda` faz, numa transação:

1. cria a venda com **snapshot de atribuição**
2. marca o imóvel como `SOLD`
3. move a oportunidade para a etapa Venda e status `WON`
4. grava a atividade e o evento de domínio

### Por que snapshot e não referência

```sql
source, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name
```

São **cópias** dos campos da oportunidade no momento da venda. Se a campanha for
renomeada ou apagada na Meta seis meses depois, a venda continua sabendo de onde
veio. É isso que sustenta a §54: da venda de volta até o anúncio.

Cancelar venda é ato de gestão: só ADMIN, exige motivo, devolve o imóvel para
`AVAILABLE` e reabre a oportunidade.

---

## VGV e as duas bases de contagem

Isto confunde quem lê o painel rápido, então está rotulado na tela:

| Métrica | Contada por |
|---|---|
| Leads, funil, origem | data de **entrada** do lead (coorte) |
| Visitas, propostas, vendas, VGV | data **delas** |

Uma venda fechada em setembro de um lead que entrou em junho é uma venda de
setembro. Por isso o card "Vendas: 1" pode conviver com "funil Venda: 0" — não é
bug, são recortes diferentes, e ambos são o que o gestor quer ver.
