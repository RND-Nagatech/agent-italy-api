const dateProperties = {
  from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Tanggal awal inklusif YYYY-MM-DD.' },
  to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Tanggal akhir inklusif YYYY-MM-DD.' },
};

export const transactionReportTools = [
  {
    type: 'function' as const,
    function: {
      name: 'get_transaction_report',
      description: 'Ambil laporan transaksi detail memakai aggregation khusus. reportType sales untuk penjualan umum: daftar transaksi tt_jual_detail Pusat dan semua cabang yang diizinkan, status_valid=DONE/status_kembali=OPEN, transaksi tukar dikecualikan; tanpa toko yang disebut jangan menanyakan pilihan toko dan jangan membatasi ke cabang saja. reportType authorization_sales untuk otorisasi penjualan dari tt_authorization; sales_non_cash untuk penjualan dari tt_jual_detail yang dihubungkan ke tt_cash_daily melalui no_faktur_group=deskripsi, dengan kategori PENJUALAN, status pembayaran OPEN, dan metode DEBET/CREDIT/TRANSFER; paymentMethod ALL untuk semua metode non-cash atau isi satu metode jika pengguna hanya meminta transfer, debet, atau credit; online_marketplace_price untuk rekonsiliasi harga online marketplace per no_faktur_group_user, termasuk barang utama, ongkos, biaya admin, packing, dan plastik bening; purchase_damaged_condition untuk Data - Rongsok Pembelian, yaitu saat pengguna menyebut pembelian rongsok atau data rongsok pembelian, dengan kondisi RUSAK 16K / 17K atau RUSAK 8K / 9K dari tt_beli_detail; login_activity untuk daftar user yang login hari ini dari collection logs, dikelompokkan per input_by dan menampilkan User ID, status login AKTIF/NONAKTIF berdasarkan event autentikasi terakhir, serta login terakhir. Hasil purchase_damaged_condition wajib menampilkan kondisi sebagai label plaintext yang sudah didekripsi, bukan ciphertext, serta field harga_nota dan harga_beli. Semua laporan memakai rentang tanggal inklusif. Laporan marketplace, non-cash, dan pembelian hanya memakai status_valid=DONE. Otorisasi tidak memakai status_valid karena tt_authorization tidak memiliki field tersebut. Jika pengguna menyebut alias cabang, cocokkan dulu ke branchId dari list_data_sources lalu isi branchIds; tanpa branchIds gunakan seluruh sumber yang diizinkan. Jangan tampilkan token atau password. Jangan gunakan aggregate_data umum untuk kebutuhan laporan ini.',
      parameters: {
        type: 'object',
        properties: {
          reportType: {
            type: 'string',
            enum: ['sales', 'authorization_sales', 'sales_non_cash', 'online_marketplace_price', 'purchase_damaged_condition', 'login_activity'],
            description: 'Jenis laporan yang diminta.',
          },
          ...dateProperties,
          branchIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 100,
            description: 'ID sumber dari list_data_sources. Kosongkan untuk semua sumber yang diizinkan.',
          },
          marketplace: {
            type: 'string',
            maxLength: 64,
            description: 'Opsional. Filter kode marketplace, misalnya TIKTOK. Hanya dipakai untuk online_marketplace_price.',
          },
          paymentMethod: {
            type: 'string',
            enum: ['ALL', 'DEBET', 'CREDIT', 'TRANSFER'],
            description: 'Opsional. Untuk sales_non_cash: ALL untuk semua metode non-cash, atau satu metode spesifik. Jika pengguna menyebut transfer/debet/credit saja, isi metode tersebut.',
          },
        },
        required: ['reportType', 'from', 'to'],
        additionalProperties: false,
      },
    },
  },
];
