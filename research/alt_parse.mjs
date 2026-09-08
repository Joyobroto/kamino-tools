// ALT account layout (v1 program): 
// AddressLookupTableState: tag(1)@0 (V1=1), id(32)@1, owner(32)@33, authority@65(32)+option,
// lastExtendedSlot(4), lastExtendedSlotStartIndex(2), deactivationSlot(8), ...
// addresses: u64 len@? then 32-byte each. Standard parser:
// 0..1 tag, 1..33 id, 33..65 owner, 65..97 authority, 97..101 lastExtendedSlotStart? — let me use
// the known community parser: off 1+32+32+1(option? no — authority is PublicKeyAccountOption? 
// Actual on-chain layout per SPL: 
// 0: u8 tag; 1..33 id; 33..65 owner; 65..97 authority(option u32 + 32)?? 
// Community consensus: addresses start after header of 1+32+32+1+4+2+8+1+4+... 
// Easiest: use account data from getAccountInfo and the SPL layout:
// - tag u8 (1)
// - id Pubkey (32)
// - owner Pubkey (32)
// - authority: COption<Pubkey> (4 + 32)
// - lastExtendedSlotStartIndex: u16? 
// - lastExtendedSlot: u64
// - _padding: u64
// - deactivationSlot: u64
// - numAddresses: u64
// - addresses: [Pubkey; numAddresses]
const total = 1 + 32 + 32 + (4 + 32) + 2 + 8 + 8 + 8 + 8;
console.log("header bytes (fixed):", total);
