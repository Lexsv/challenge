import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clearMockSessions, deleteMockUser, sampleUsers, updateMockUser, UsersPage } from "./users-page";

describe("sample Users page", () => {
  it("renders the system user and two sample profiles with their actions", () => {
    const html=renderToStaticMarkup(<UsersPage />);
    for (const text of ["General", "Alex", "Developer", "Prefers detailed technical explanations", "Prefers short answers with code examples", "Add User", "Clear Sessions", "Sample data only", "Habits", "Sessions", "Actions"]) expect(html).toContain(text);
    expect(html.indexOf('>General<')).toBeLessThan(html.indexOf('>Alex<'));
    expect(html).toContain('aria-label="Sample users"');
    expect(html.match(/MuiTableCell-alignCenter/g)).toHaveLength(4);
    expect(html.match(/MuiTableCell-alignRight/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Habits for Alex: Prefers detailed technical explanations"');
    expect(html).not.toContain('aria-label="Edit General"');
    expect(html).not.toContain('aria-label="Delete General"');
    expect(html).toContain('aria-label="Edit Alex"');
    expect(html).toContain('aria-label="Delete Developer"');
  });
  it("adds, edits and removes only sample users while protecting General", () => {
    const alex=sampleUsers[1];
    expect(updateMockUser(sampleUsers,{...alex,habits:"New preference"}).find(user=>user.id==='alex')?.habits).toBe('New preference');
    expect(updateMockUser(sampleUsers,{id:'new',name:' Sam ',habits:'Examples',sessions:[]}).at(-1)?.name).toBe('Sam');
    expect(updateMockUser(sampleUsers,{...sampleUsers[0],name:'Changed'})[0].name).toBe('General');
    expect(deleteMockUser(sampleUsers,'general')).toHaveLength(3);
    expect(deleteMockUser(sampleUsers,'alex').some(user=>user.id==='alex')).toBe(false);
    expect(clearMockSessions(sampleUsers,'general')[0].sessions).toEqual([]);
    expect(sampleUsers[0].sessions).toEqual(['Welcome session']);
  });
});
