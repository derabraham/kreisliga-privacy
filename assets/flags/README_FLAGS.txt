KFM WEB DATABASE EDITOR - FLAGS
================================

Put reusable flag images in this folder.
Supported extensions: .png, .jpg, .jpeg, .webp, .svg

To make them appear in the nation flag picker, add them to flags.json.
Example:

{
  "Afghanistan": "afghanistan.png",
  "England": "england.png",
  "Germany": "germany.png",
  "Fantasy Red": "fantasy-red.png"
}

The left side is the display label shown in the picker.
The right side is the file name inside /assets/flags/.

A nation can store the selected reusable flag as `flagWebAsset`.
Custom flags uploaded while editing a .kfmdb are still embedded in the exported package.
