import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

// Expose Tooltip configuration during static rendering; interaction is verified separately in a browser.
vi.mock('@mui/material',async importOriginal=>{
  const actual=await importOriginal<typeof import('@mui/material')>();
  return {...actual,Tooltip:({children,placement,slotProps}:{children:ReactNode;placement?:string;slotProps?:{tooltip?:{sx?:{maxWidth?:number;whiteSpace?:string}}}})=><span data-placement={placement} data-max-width={slotProps?.tooltip?.sx?.maxWidth} data-wrap={slotProps?.tooltip?.sx?.whiteSpace}>{children}</span>};
});

import { SessionMemoryCard } from './session-memory-card';

it('configures the three information tooltips above the icons with wrapped 260px content',()=>{
  const html=renderToStaticMarkup(<SessionMemoryCard snapshot={{revision:0,data:null}} shortTokens={0} />);
  expect((html.match(/data-placement="top"/g) ?? [])).toHaveLength(3);
  expect((html.match(/data-max-width="260"/g) ?? [])).toHaveLength(3);
  expect((html.match(/data-wrap="normal"/g) ?? [])).toHaveLength(3);
});
