import { api } from './client'

export const usersApi = {
  list: () => api.get('/users'),
  create: (data: { username: string; password: string; role: string }) => api.post('/users', data),
  update: (username: string, data: { role?: string; password?: string }) => api.put(`/users/${username}`, data),
  delete: (username: string) => api.del(`/users/${username}`),
}

export const profileApi = {
  get: () => api.get('/profile'),
  changePassword: (oldPw: string, newPw: string) => api.post('/profile/password', { old: oldPw, new: newPw }),
  unbind: (identityId: string) => api.post('/profile/unbind', { id: identityId }),
}
