import { api } from './client'

export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ user: string; role: string; perms: string[]; is_logged_in: boolean }>('/auth/login', { username, password }),

  logout: () => api.post('/auth/logout'),

  guest: () =>
    api.post<{ user: string; role: string; perms: string[]; is_logged_in: boolean }>('/auth/guest'),

  me: () =>
    api.get<{ user: string; role: string; perms: string[]; is_logged_in: boolean }>('/auth/me'),
}
