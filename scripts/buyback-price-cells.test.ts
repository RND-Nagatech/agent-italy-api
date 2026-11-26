import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBuybackPriceCells, type PriceCell } from '../src/agent/buyback-price-cells';

test('physical column cells correct a green price spilling into the blue C4 block', () => {
  const rows = ['C2', 'C9', 'C4', 'C5'].map(sourceCode => ({ sourceCode, goodThousands: 1539, scrapThousands: 1354, stoneMinThousands: 1396, stoneMaxThousands: 1428 }));
  const cells: PriceCell[] = [
    { condition:'GOOD',fromRow:0,toRow:2,rateThousands:1539,maxRateThousands:null },
    { condition:'GOOD',fromRow:3,toRow:3,rateThousands:1544,maxRateThousands:null },
    { condition:'SCRAP',fromRow:0,toRow:3,rateThousands:1459,maxRateThousands:null },
    { condition:'STONE',fromRow:0,toRow:3,rateThousands:1502,maxRateThousands:1533 },
  ];
  const verified=applyBuybackPriceCells(rows,cells);
  assert.deepEqual(verified[2], { sourceCode:'C4',goodThousands:1539,scrapThousands:1459,stoneMinThousands:1502,stoneMaxThousands:1533 });
  assert.equal(verified[3].goodThousands,1544);assert.equal(rows[2].stoneMinThousands,1396,'does not mutate the initial reading');
  assert.throws(()=>applyBuybackPriceCells(rows,cells.slice(0,-1)),/Missing/);
  assert.throws(()=>applyBuybackPriceCells(rows,[...cells,cells[3]]),/overlapping/);
  assert.throws(()=>applyBuybackPriceCells(rows,[...cells.slice(0,-1),{...cells[3],toRow:4}]),/Invalid/);
  assert.throws(()=>applyBuybackPriceCells(rows,[...cells.slice(0,-1),{...cells[3],maxRateThousands:null}]),/Invalid/);
  assert.equal(applyBuybackPriceCells(rows,[...cells.slice(0,-1),{...cells[3],rateThousands:null,maxRateThousands:null}])[2].stoneMinThousands,null,'explicit blank cells stay blank');
});
