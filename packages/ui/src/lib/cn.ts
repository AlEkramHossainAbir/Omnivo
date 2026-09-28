import { extendTailwindMerge } from 'tailwind-merge';

// class জোড়া লাগানো + সংঘাত মেটানো: cn('px-4', 'px-6') → 'px-6'। ডাক-দেওয়া কোডের class
// সবসময় জেতে, CSS ফাইলে কোন rule আগে তৈরি হলো তার উপর নির্ভর করে না
export const cn = extendTailwindMerge({
  extend: {
    theme: {
      // এগুলো না জানালে tailwind-merge `text-body`-কে রং ভাবত, আর cn('text-body', 'text-ink')
      // চুপচাপ font-size মুছে দিত
      text: ['display', 'h1', 'h2', 'kpi', 'h3', 'body', 'body-sm', 'label', 'caption', 'micro'],
      radius: ['control', 'card', 'panel'],
      shadow: ['ring', 'ring-crit'],
    },
  },
});
