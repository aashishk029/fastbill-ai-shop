import axios from 'axios';

// The backend no longer answers on the strength of a shop id alone, so every request from
// this app has to carry the session it was given at signup.
//
// Two things need attaching, not one: components here call bare axios.get/post with a full
// URL, while App.js talks through its own axios.create() instance. An instance copies
// axios.defaults at creation time and does not inherit interceptors added later, so
// setting a default header in one place would silently miss half the call sites.
export function attachSession(instance) {
  instance.interceptors.request.use((config) => {
    const token = localStorage.getItem('sessionToken');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
}

export function storeSession(token) {
  if (token) localStorage.setItem('sessionToken', token);
  else localStorage.removeItem('sessionToken');
}

// Covers every bare axios.* call in the components.
attachSession(axios);
