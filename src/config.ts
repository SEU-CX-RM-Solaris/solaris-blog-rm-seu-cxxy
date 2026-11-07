import type { Config } from '@type/config';

const config: Config = {
  title: '天钺 Solaris · RoboMaster 技术博客',
  author: '天钺 Solaris',
  avatar: '/assets/images/avatar.jpg',
  description:
    '东南大学成贤学院（SEU-CXXY）RoboMaster 天钺 Solaris 战队技术博客 —— 建模 · 电控 · 硬件 · 视觉，四个方向的技术沉淀。',
  site_url: 'https://seu-cx-rm-solaris.github.io',
  theme: 'nayuta',
  since: '2026-10-01',
  postsPerPage: 10,
  copyright: { enabled: true, license: 'CC BY-NC-SA 4.0' },
  links: [
    {
      text: 'Posts',
      url: '/solaris-blog-rm-seu-cxxy/posts',
      icon: {
        type: 'icon',
        name: 'fa-solid fa-file-lines',
      },
    },
    {
      text: 'About',
      url: '/solaris-blog-rm-seu-cxxy/about',
      icon: {
        type: 'icon',
        name: 'fa-solid fa-circle-info',
      },
    },
  ],
};

export default config;
