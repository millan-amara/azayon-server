/*
 * Grant or revoke platform superadmin access.
 *
 *   node server/scripts/promoteSuperadmin.js <email>            # grant
 *   node server/scripts/promoteSuperadmin.js <email> --revoke   # revoke
 *   node server/scripts/promoteSuperadmin.js --list             # list current superadmins
 *
 * Run from the project root (or anywhere — paths are resolved relative to this file).
 * Loads MONGO_URI from server/.env via dotenv.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/promoteSuperadmin.js <email> [--revoke]   |   --list');
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Add it to server/.env and try again.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  try {
    if (args[0] === '--list') {
      const admins = await User.find({ isSuperadmin: true })
        .select('name email orgId createdAt lastLogin')
        .populate('orgId', 'name slug')
        .lean();
      if (admins.length === 0) {
        console.log('No superadmins yet.');
      } else {
        console.log(`${admins.length} superadmin(s):`);
        for (const u of admins) {
          console.log(`  - ${u.email}  (${u.name})  org: ${u.orgId?.name || '—'}  last login: ${u.lastLogin || 'never'}`);
        }
      }
      return;
    }

    const email = args[0].toLowerCase();
    const revoke = args.includes('--revoke');

    const user = await User.findOne({ email });
    if (!user) {
      console.error(`No user with email ${email}`);
      process.exit(2);
    }

    if (revoke) {
      const remaining = await User.countDocuments({ isSuperadmin: true, _id: { $ne: user._id } });
      if (user.isSuperadmin && remaining === 0) {
        console.error(`Refusing to revoke ${email}: they are the last superadmin.`);
        process.exit(3);
      }
      user.isSuperadmin = false;
      await user.save();
      console.log(`Revoked superadmin from ${email}`);
    } else {
      if (user.isSuperadmin) {
        console.log(`${email} is already a superadmin. Nothing to do.`);
      } else {
        user.isSuperadmin = true;
        await user.save();
        console.log(`Granted superadmin to ${email}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
