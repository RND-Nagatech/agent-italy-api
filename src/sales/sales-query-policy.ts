import { Document } from 'mongodb';

export const VALID_SALES_STATUS = {
  status_kembali: 'OPEN',
  status_valid: 'DONE',
} as const;

export function validSalesMatch(): Document {
  return {
    ...VALID_SALES_STATUS,
    status_tukar: { $ne: true },
    trs_barang_tukar: { $ne: true },
  };
}
