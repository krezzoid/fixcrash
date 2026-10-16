export interface InboxItem {
  title: string;
}

export interface Inbox {
  items: InboxItem[];
}

/** The inbox's headline: the newest item's title. */
export async function loadHeadline(source: {
  inbox(): Promise<Inbox>;
}): Promise<string> {
  const response = await source.inbox();
  return response.items[0].title;
}
