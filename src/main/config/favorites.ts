import * as path from 'path';
import * as fs from 'fs';
import { getUserDataDir } from '../utils';

let favorites: Set<string> | null = null;

function filePath(): string {
  return path.join(getUserDataDir(), 'favorites.json');
}

function load(): Set<string> {
  if (favorites) {
    return favorites;
  }
  try {
    const data = fs.readFileSync(filePath(), 'utf-8');
    const ids: unknown = JSON.parse(data);
    favorites = new Set(
      Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
    );
  } catch {
    favorites = new Set();
  }
  return favorites;
}

function save() {
  fs.writeFileSync(filePath(), JSON.stringify([...load()]));
}

export function getFavorites(): string[] {
  return [...load()];
}

export function toggleFavorite(id: string): string[] {
  const set = load();
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  save();
  return [...set];
}
