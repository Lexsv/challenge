import { expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('react',async importOriginal=>{
  const actual=await importOriginal<typeof import('react')>();
  return {...actual,useState:vi.fn(),useId:()=>':test:'};
});

import { isValidElement, useState } from 'react';
import { Button, IconButton, Tooltip } from '@mui/material';
import { SessionMemoryCard } from './session-memory-card';

function flatten(node:ReactNode):ReactElement<Record<string,any>>[] {
  if(Array.isArray(node))return node.flatMap(flatten);
  if(!isValidElement<Record<string,any>>(node))return [];
  return [node,...flatten(node.props.children)];
}

it('routes row and information interactions independently for each category',()=>{
  const select=vi.fn(),showInfo=vi.fn();
  vi.mocked(useState).mockReturnValueOnce([null,select]).mockReturnValueOnce([null,showInfo]);
  const tree=SessionMemoryCard({snapshot:{revision:0,data:null},shortTokens:0});
  const nodes=flatten(tree);
  for(const [id,label] of [['short','Short-term memory'],['summary','Medium-term memory'],['facts','Long-term memory']] as const){
    const row=nodes.find(node=>node.type===Button && node.props['aria-label']===`Open ${label} details`)!;
    const tooltip=nodes.find(node=>node.type===Tooltip && node.props.children?.props?.['aria-label']===`About ${label}`)!;
    const info=tooltip.props.children as ReactElement<Record<string,any>>;
    expect(info.type).toBe(IconButton);
    expect(row.props.onMouseEnter).toBeUndefined();
    row.props.onClick();expect(select).toHaveBeenLastCalledWith(id);
    tooltip.props.onOpen();expect(showInfo).toHaveBeenLastCalledWith(id);
    tooltip.props.onClose();expect(showInfo).toHaveBeenLastCalledWith(null);
    const selectedCalls=select.mock.calls.length;const stopPropagation=vi.fn();info.props.onClick({stopPropagation});expect(stopPropagation).toHaveBeenCalledOnce();expect(showInfo).toHaveBeenLastCalledWith(id);expect(select).toHaveBeenCalledTimes(selectedCalls);
  }
});
