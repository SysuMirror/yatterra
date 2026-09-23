import { api } from './client'
export interface AuthResponse { user: string | null; user_id?: string | null; username?: string | null; display_name?: string | null; avatar_url?: string | null; display_source?: string | null; role: string | null; perms: string[]; is_logged_in: boolean }
export const authApi = { login: (username: string, password: string) => api.post<AuthResponse>('/auth/login', { username, password }), logout: () => api.post('/auth/logout'), guest: () => api.post<AuthResponse>('/auth/guest'), me: () => api.get<AuthResponse>('/auth/me') }
