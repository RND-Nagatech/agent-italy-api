import type { Document } from 'mongodb';
import { validSalesMatch } from '../sales/sales-query-policy';

const number = (field: string) => ({ $convert: { input: `$${field}`, to: 'double', onNull: 0, onError: 0 } });

export function salesTransactionsPipeline(range: { from: string; to: string }, detailLimit: number): Document[] {
  return [
    { $match: { ...validSalesMatch(), tgl_system: { $gte: range.from, $lte: range.to } } },
    {
      $facet: {
        totals: [
          { $group: { _id: '$no_faktur_jual', detailCount: { $sum: 1 }, salesAmountIdr: { $sum: number('harga_total') }, weightGram: { $sum: number('berat') } } },
          { $group: { _id: null, invoiceCount: { $sum: { $cond: [{ $and: [{ $ne: ['$_id', null] }, { $ne: ['$_id', ''] }] }, 1, 0] } }, detailCount: { $sum: '$detailCount' }, salesAmountIdr: { $sum: '$salesAmountIdr' }, weightGram: { $sum: '$weightGram' } } },
          { $project: { _id: 0, invoiceCount: 1, detailCount: 1, salesAmountIdr: 1, weightGram: 1 } },
        ],
        rows: [
          { $sort: { tgl_system: -1, _id: -1 } },
          { $limit: detailLimit },
          { $project: { _id: 0, tgl_system: 1, no_faktur_jual: 1, kode_barcode: 1, nama_barang: 1, berat: number('berat'), harga_total: number('harga_total'), input_by: 1 } },
        ],
      },
    },
  ];
}
