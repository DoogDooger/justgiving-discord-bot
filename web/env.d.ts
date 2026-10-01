/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    web: import('../src/web/api.js').WebApi;
  }
}
