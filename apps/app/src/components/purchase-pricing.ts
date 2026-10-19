import { routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useQuery } from '@tanstack/react-query';

import { call } from '../lib/api';
import { purchaseUnitOf, startingPrice } from '../lib/purchase';
import { taxRatesQuery } from '../lib/queries';
import { type LinePricing, linePriceKey } from './sales-line-editor';
import { useTenantId } from './stock-parts';

// The supplier's prices (17b, decision 19): its own last price, else anyone's, else the average
// cost. The lookup sends the net; startingPrice() adds the VAT when the document's prices include
// it. Moved here from purchase-order-lines.tsx in step 17c: a supplier bill's own lines start at the
// same prices, and importing the hook from the order's editor would pull that whole chunk in.
// `noLines` is the empty card's text, which differs by document.
export function usePurchasePricing(
  supplierId: string,
  pricesIncludeVat: boolean,
  noLines: string,
): LinePricing {
  const { t } = useLocale();
  const rates = useQuery(taxRatesQuery(useTenantId())).data;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  return {
    partyId: supplierId,
    unitOf: purchaseUnitOf,
    lookUp: async (items) => {
      const answer = await call(routes.purchaseCosts.lookup, {
        body: { supplierId: supplierId === '' ? null : supplierId, items: [...items] },
      });
      return new Map(
        answer.items.map((item) => [
          linePriceKey(item.variantId, item.unitId),
          {
            price: startingPrice(item.cost, rateOf(item.taxRateId), pricesIncludeVat),
            source: item.source,
            taxRateId: item.taxRateId,
          },
        ]),
      );
    },
    sourceText: (source) =>
      source === 'supplier_price'
        ? t('purchaseLines.fromSupplierPrice')
        : source === 'last_price'
          ? t('purchaseLines.fromLastPrice')
          : source === 'average_cost'
            ? t('purchaseLines.fromAverage')
            : t('purchaseLines.noPrice'),
    words: {
      noLines,
      reprice: t('purchaseLines.reprice'),
      repriced: t('purchaseLines.repriced'),
    },
    picker: { words: 'purchaseLines', description: t('purchaseLines.orderPickerDescription') },
  };
}
