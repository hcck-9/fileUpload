import axios from "axios";

const myBaseUrl = "http://localhost:3000";

const service = axios.create({
  baseURL: myBaseUrl,
  timeout: 6 * 1000,
});

// 响应拦截
service.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default service;
