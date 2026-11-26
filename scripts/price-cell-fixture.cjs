// Offline second-pass replies use the fixture document, never a real image/provider.
exports.withPriceCellVerification = modelFetch => {
  const byImage = new Map();
  return async (url, options) => {
    const payload = JSON.parse(options.body), parts = payload.messages[1].content;
    const image = parts.find(part => part.type === 'image_url')?.image_url.url;
    if (payload.messages[0].content.startsWith('VERIFY_BUYBACK_PRICE_CELLS')) {
      const { tables } = JSON.parse(parts.find(part => part.type === 'text').text);
      const originals = byImage.get(image);
      const documents = tables.map(table => {
        const original = originals.find(page => page.batch === table.batch && page.date === table.date) || originals[0];
        const cells = original.buybackRows.flatMap((row, rowIndex) => [
          { condition:'GOOD',fromRow:rowIndex,toRow:rowIndex,rateThousands:row.goodThousands,maxRateThousands:null },
          { condition:'SCRAP',fromRow:rowIndex,toRow:rowIndex,rateThousands:row.scrapThousands,maxRateThousands:null },
          { condition:'STONE',fromRow:rowIndex,toRow:rowIndex,rateThousands:row.stoneMinThousands,maxRateThousands:row.stoneMaxThousands },
        ]);
        return {tableIndex:table.tableIndex,complete:true,warnings:[],cells};
      });
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({documents})}}]}),{status:200});
    }
    const response = await modelFetch(url, options);
    try { const body = await response.clone().json();const parsed=JSON.parse(body.choices[0].message.content);byImage.set(image,parsed.documents?.length?parsed.documents:[parsed]); } catch {}
    return response;
  };
};
